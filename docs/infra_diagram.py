"""Generates docs/infra-architecture.drawio (mxGraph XML) for a clean,
professional draw.io-style diagram. Export to PNG with:

    drawio.exe -x -f png -o docs/infra-architecture.png docs/infra-architecture.drawio

Status reflects actual repo state: the whole licensing system (capability
gate, license cache, server, payments) is unimplemented today -- only
proposed in issue #3 -- so all of it is "todo", not "done".
"""
import xml.etree.ElementTree as ET

DONE = "rounded=1;whiteSpace=wrap;html=1;fillColor=#dcfce7;strokeColor=#22c55e;fontColor=#14532d;fontSize=12;fontStyle=0;arcSize=12;"
TODO = "rounded=1;whiteSpace=wrap;html=1;fillColor=#fee2e2;strokeColor=#ef4444;fontColor=#7f1d1d;fontSize=12;fontStyle=0;arcSize=12;"
BOX = "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#9ca3af;fontSize=13;fontStyle=1;verticalAlign=top;align=left;spacingLeft=6;spacingTop=4;arcSize=6;"
OUTER_LOCAL = "rounded=1;whiteSpace=wrap;html=1;fillColor=#eff6ff;strokeColor=#3b82f6;dashed=1;dashPattern=8 4;fontSize=18;fontStyle=1;verticalAlign=top;align=left;spacingLeft=14;spacingTop=10;arcSize=4;"
OUTER_CLOUD = "rounded=1;whiteSpace=wrap;html=1;fillColor=#fafaf5;strokeColor=#9ca3af;dashed=1;dashPattern=8 4;fontSize=18;fontStyle=1;verticalAlign=top;align=left;spacingLeft=14;spacingTop=10;arcSize=4;"
LEGEND = "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#9ca3af;dashed=1;fontSize=14;fontStyle=1;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;"
EDGE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;fontSize=11;strokeColor=#6b7280;endArrow=block;endFill=1;jettySize=auto;"
EDGE_FUTURE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;fontSize=11;strokeColor=#ef4444;dashed=1;endArrow=block;endFill=1;jettySize=auto;"

mxfile = ET.Element("mxfile", host="app.diagrams.net")
diagram = ET.SubElement(mxfile, "diagram", name="RawStudio infra")
model = ET.SubElement(diagram, "mxGraphModel", dx="1600", dy="900", grid="0", gridSize="10",
                       guides="1", tooltips="1", connect="1", arrows="1", fold="1", page="1",
                       pageScale="1", pageWidth="1700", pageHeight="1180", math="0", shadow="0")
root = ET.SubElement(model, "root")
ET.SubElement(root, "mxCell", id="0")
ET.SubElement(root, "mxCell", id="1", parent="0")

_id = [10]


def nid():
    _id[0] += 1
    return f"n{_id[0]}"


def vertex(label, style, x, y, w, h, parent="1"):
    i = nid()
    cell = ET.SubElement(root, "mxCell", id=i, value=label, style=style, vertex="1", parent=parent)
    ET.SubElement(cell, "mxGeometry", x=str(x), y=str(y), width=str(w), height=str(h), **{"as": "geometry"})
    return i


def edge(src, dst, label="", style=EDGE, waypoints=None, label_dx=0, label_dy=0):
    i = nid()
    cell = ET.SubElement(root, "mxCell", id=i, value=label, style=style, edge="1", parent="1", source=src, target=dst)
    geo = ET.SubElement(cell, "mxGeometry", relative="1", **{"as": "geometry"})
    if label_dx or label_dy:
        ET.SubElement(geo, "mxPoint", x=str(label_dx), y=str(label_dy), **{"as": "offset"})
    if waypoints:
        arr = ET.SubElement(geo, "Array", **{"as": "points"})
        for px, py in waypoints:
            ET.SubElement(arr, "mxPoint", x=str(px), y=str(py))
    return i


# ---- Legend ----
vertex("LEGEND", LEGEND, 40, 20, 360, 60)
vertex("shipped / done", DONE, 60, 50, 150, 26)
vertex("todo #N (GitHub issue)", TODO, 230, 50, 150, 26)

# ---- Outer containers ----
vertex("LOCAL  —  Desktop App  (runs on the user's machine)", OUTER_LOCAL, 40, 100, 800, 680)
vertex("CLOUD  —  Online Services  (hosted, shared by all users)", OUTER_CLOUD, 880, 100, 760, 570)

# ---- LOCAL / Frontend ----
vertex("Frontend (React/WebView)", BOX, 60, 150, 370, 230)
n_lib = vertex("Library, Import,\nDevelop, Settings", DONE, 80, 190, 150, 50)
n_export = vertex("Export dialog", DONE, 260, 190, 150, 50)
n_todo6 = vertex("todo #6\none-click export", TODO, 260, 260, 150, 50)
edge(n_export, n_todo6)

# ---- LOCAL / Sidecar ----
vertex("FastAPI sidecar", BOX, 450, 150, 370, 230)
n_side = vertex("Subject/click select, AI denoise,\nGPU diff, models manager", DONE, 470, 190, 330, 50)
n_todo1 = vertex("todo #1\nInpainting (MI-GAN)", TODO, 470, 260, 150, 50)
n_todo5 = vertex("todo #5\nfinalize AI model links", TODO, 650, 260, 150, 50)
edge(n_side, n_todo1)
edge(n_side, n_todo5)

# ---- LOCAL / Storage ----
vertex("Local storage", BOX, 60, 410, 370, 180)
n_store = vertex("SQLite catalog +\nRAW files", DONE, 80, 450, 150, 50)
n_cache = vertex("todo #3\nlicense cache\n(offline grace period)", TODO, 260, 450, 150, 60)

# ---- LOCAL / Packaging ----
vertex("Build and packaging", BOX, 450, 410, 370, 180)
n_docker = vertex("Docker dev env\n(hot reload)", DONE, 470, 440, 150, 50)
n_installers = vertex("Windows / Linux\ninstallers (.exe/.deb/.rpm)", DONE, 650, 440, 150, 60)
n_mac = vertex("todo (no issue yet)\nmacOS installer (.dmg)", TODO, 650, 510, 150, 60)
n_updater = vertex("issue #14\nauto-updater (signed,\nchecks GitHub Releases)", DONE, 470, 510, 150, 60)
edge(n_docker, n_installers)
edge(n_docker, n_mac)

# ---- LOCAL / future note ----
vertex("Tauri shell bundles the frontend + sidecar together; CI builds, signs and\npublishes the installers above to GitHub Releases, which the app polls for updates.", LEGEND, 60, 620, 760, 60)

# ---- CLOUD / Licensing (placed FIRST/left, right next to the LOCAL/CLOUD
# gap, since it's the one with a cross-boundary dependency on Local storage
# -- keeps that dashed edge short) ----
vertex("Licensing Server  (nothing built yet)", BOX, 900, 195, 330, 160)
n_design = vertex("todo #3\nlicensing system\n(plans, capabilities)", TODO, 915, 235, 145, 60)
n_setup = vertex("todo #12\nset up licensing server", TODO, 1075, 235, 145, 60)
edge(n_design, n_setup)

# ---- CLOUD / CI-CD (placed second/right) ----
vertex("CI / CD", BOX, 1250, 195, 370, 160)
n_gha = vertex("GitHub Actions\n(build + tests)", DONE, 1265, 235, 150, 50)
n_ghrel = vertex("GitHub Releases\n(.exe / .deb / .rpm)", DONE, 1435, 235, 165, 50)
edge(n_gha, n_ghrel)

# ---- CLOUD / Website (todo grid on the left; the site hub sits on the
# right, directly under CI/CD, so its dashed link to GitHub Releases is a
# short straight hop instead of crossing the whole row) ----
vertex("Website  (nothing built yet)", BOX, 900, 385, 720, 240)
n_todo8 = vertex("todo #8\nvisual identity", TODO, 920, 435, 140, 50)
n_todo10 = vertex("todo #10\napply identity", TODO, 920, 515, 140, 50)
n_todo9 = vertex("todo #9\nbuild website", TODO, 1090, 435, 140, 50)
n_todo11 = vertex("todo #11\nwebsite hosting", TODO, 1090, 515, 140, 50)
n_site = vertex("Marketing\nWebsite", TODO, 1430, 495, 110, 60)
edge(n_site, n_todo8)
edge(n_site, n_todo9)
edge(n_site, n_todo10)
edge(n_site, n_todo11)
edge(n_site, n_ghrel, "will link to", EDGE_FUTURE, waypoints=[(1485, 460), (1485, 355)])

# ---- Cross-boundary edges (explicit waypoints: clear corridor below the
# CLOUD title, well above the Website box, so they never cross other content
# or each other) ----
edge(n_installers, n_gha, "publishes via", EDGE, waypoints=[(860, 475), (860, 175), (1340, 175)], label_dx=-40, label_dy=-10)
edge(n_cache, n_design, "will activate / verify", EDGE_FUTURE,
     waypoints=[(335, 605), (845, 605), (845, 265)], label_dx=0, label_dy=-10)
edge(n_ghrel, n_updater, "checks latest.json", EDGE,
     waypoints=[(1517, 285), (1517, 575), (620, 575)], label_dx=0, label_dy=-10)

tree = ET.ElementTree(mxfile)
ET.indent(tree, space="  ")
tree.write("docs/infra-architecture.drawio", encoding="utf-8", xml_declaration=True)
print("wrote docs/infra-architecture.drawio")
