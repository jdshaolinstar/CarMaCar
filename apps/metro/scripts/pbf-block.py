# Pulls the roads, buildings and parking of a small area out of a Geofabrik extract.
# Run: python apps/metro/scripts/pbf-block.py <input.osm.pbf> <output.json> <south> <west> <north> <east>
# Two passes, so memory stays small: first the points inside the box, then the shapes that use them.
import json
import sys

import osmium

ROADS = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link", "residential", "unclassified", "service"}
KEEP_TAGS = ("highway", "name", "ref", "oneway", "lanes", "maxspeed", "building", "building:levels", "height", "amenity", "parking", "shop", "tourism", "historic")


class Points(osmium.SimpleHandler):
    def __init__(self, box):
        super().__init__()
        self.box = box
        self.points = {}

    def node(self, n):
        south, west, north, east = self.box
        if n.location.valid() and south <= n.location.lat <= north and west <= n.location.lon <= east:
            self.points[n.id] = (round(n.location.lat, 6), round(n.location.lon, 6))


class Shapes(osmium.SimpleHandler):
    def __init__(self, points):
        super().__init__()
        self.points = points
        self.shapes = []

    def way(self, w):
        tags = w.tags
        road = tags.get("highway") in ROADS
        building = "building" in tags
        parking = tags.get("amenity") == "parking"
        if not (road or building or parking):
            return
        inside = [self.points[n.ref] for n in w.nodes if n.ref in self.points]
        # Buildings must be fully inside, or a footprint gets cut in half at the edge of the box.
        if (building or parking) and len(inside) != len(w.nodes):
            return
        if road and len(inside) < 2:
            return
        self.shapes.append({"id": w.id, "points": inside, "tags": {k: tags[k] for k in KEEP_TAGS if k in tags}})


def main():
    source, target = sys.argv[1], sys.argv[2]
    box = tuple(map(float, sys.argv[3:7]))
    points = Points(box)
    points.apply_file(source)
    print(len(points.points), "points in the box", flush=True)
    shapes = Shapes(points.points)
    shapes.apply_file(source)
    with open(target, "w", encoding="utf-8") as out:
        json.dump({"box": box, "shapes": shapes.shapes}, out, separators=(",", ":"))
    roads = sum(1 for s in shapes.shapes if "highway" in s["tags"])
    buildings = sum(1 for s in shapes.shapes if "building" in s["tags"])
    print(roads, "roads,", buildings, "buildings", flush=True)


main()
