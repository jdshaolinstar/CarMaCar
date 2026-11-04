# Pulls parking lots and garages out of a Geofabrik extract, for drawing on the map.
# Run: python apps/metro/scripts/pbf-parking.py <input.osm.pbf> <output.json> <south> <west> <north> <east>
import json
import sys

import osmium


class Parking(osmium.SimpleHandler):
    def __init__(self, box):
        super().__init__()
        self.box = box
        self.items = []

    def keep(self, lat, lon, tags):
        south, west, north, east = self.box
        if not (south <= lat <= north and west <= lon <= east):
            return
        capacity = tags.get("capacity", "")
        kind = tags.get("parking", "surface")
        self.items.append(
            {
                "lat": round(lat, 5),
                "lon": round(lon, 5),
                "garage": kind in ("multi-storey", "underground"),
                "capacity": int(capacity) if capacity.isdigit() else None,
                "name": tags.get("name"),
            }
        )

    def node(self, n):
        if n.tags.get("amenity") == "parking":
            self.keep(n.location.lat, n.location.lon, n.tags)

    def area(self, a):
        if a.tags.get("amenity") != "parking":
            return
        try:
            first = next(iter(a.outer_rings()))
            points = [(p.lat, p.lon) for p in first]
        except Exception:
            return
        if points:
            lat = sum(p[0] for p in points) / len(points)
            lon = sum(p[1] for p in points) / len(points)
            self.keep(lat, lon, a.tags)


def main():
    source, target = sys.argv[1], sys.argv[2]
    box = tuple(map(float, sys.argv[3:7]))
    handler = Parking(box)
    handler.apply_file(source, locations=True, idx="flex_mem")
    with open(target, "w", encoding="utf-8") as out:
        json.dump(handler.items, out, separators=(",", ":"))
    garages = sum(1 for item in handler.items if item["garage"])
    print(len(handler.items), "parking places,", garages, "garages", flush=True)


main()
