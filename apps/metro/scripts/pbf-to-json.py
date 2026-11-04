# Converts a Geofabrik .osm.pbf extract into the same JSON the Overpass download produces.
# Run: python apps/metro/scripts/pbf-to-json.py <input.osm.pbf> <output.json> <south> <west> <north> <east>
# Keeps major roads inside the box, and only the nodes those roads use.
import json
import sys

import osmium

KEEP = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link",
}
TAGS = ("highway", "oneway", "lanes", "maxspeed", "name", "ref")


class Roads(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []
        self.wanted = set()

    def way(self, w):
        if w.tags.get("highway") in KEEP:
            ids = [n.ref for n in w.nodes]
            self.ways.append({"type": "way", "id": w.id, "nodes": ids, "tags": {k: w.tags[k] for k in TAGS if k in w.tags}})
            self.wanted.update(ids)


class Nodes(osmium.SimpleHandler):
    def __init__(self, wanted):
        super().__init__()
        self.wanted = wanted
        self.nodes = {}

    def node(self, n):
        if n.id in self.wanted:
            item = {"type": "node", "id": n.id, "lat": round(n.location.lat, 6), "lon": round(n.location.lon, 6)}
            if n.tags.get("highway") == "traffic_signals":
                item["tags"] = {"highway": "traffic_signals"}
            self.nodes[n.id] = item


def main():
    source, target = sys.argv[1], sys.argv[2]
    south, west, north, east = map(float, sys.argv[3:7])
    roads = Roads()
    roads.apply_file(source)
    print("roads in file", len(roads.ways), flush=True)
    nodes = Nodes(roads.wanted)
    nodes.apply_file(source)
    print("nodes used", len(nodes.nodes), flush=True)
    inside = lambda n: south <= n["lat"] <= north and west <= n["lon"] <= east
    keep = []
    for way in roads.ways:
        # A road is split where it leaves the box, so what remains is still continuous.
        run = []
        for node_id in way["nodes"]:
            node = nodes.nodes.get(node_id)
            if node and inside(node):
                run.append(node_id)
            else:
                if len(run) > 1:
                    keep.append({**way, "nodes": run})
                run = []
        if len(run) > 1:
            keep.append({**way, "nodes": run})
    used = {i for way in keep for i in way["nodes"]}
    elements = [nodes.nodes[i] for i in used] + keep
    with open(target, "w", encoding="utf-8") as out:
        json.dump({"elements": elements}, out, separators=(",", ":"))
    print("kept", len(keep), "roads and", len(used), "nodes", flush=True)


main()
