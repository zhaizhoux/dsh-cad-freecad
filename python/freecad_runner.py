# -*- coding: utf-8 -*-
"""FreeCAD job runner for dsh-cad-freecad.

Invoked as:  freecadcmd freecad_runner.py
Job JSON is passed through the DSH_CAD_JOB environment variable. The runner
prints exactly one machine-readable line prefixed with DSH_CAD_RESULT: and
nothing else on stdout (FreeCAD's own banner is tolerated).

Security contract:
  - The document is pure data. No field is ever eval'd, exec'd or imported.
  - All paths come from the trusted Node caller, which confines them to workDir.
  - Numeric fields are floats or $parameter references into the document.
"""
import hashlib
import json
import os
import sys
import traceback

PREFIX = os.environ.get("DSH_CAD_RESULT_PREFIX", "DSH_CAD_RESULT:")
JOB_PATH = os.environ.get("DSH_CAD_JOB", "")


def emit(payload):
    sys.stdout.write(PREFIX + json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def fail(code, message, details=None):
    error = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    emit({"success": False, "error": error})
    sys.exit(1)


class JobError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.details = details


def load_job():
    if not JOB_PATH:
        raise JobError("job_missing", "DSH_CAD_JOB is not set")
    with open(JOB_PATH, "r", encoding="utf-8") as handle:
        return json.load(handle)


# --------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------

def number(value, params):
    if isinstance(value, bool):
        raise JobError("invalid_value", "boolean is not a number")
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.startswith("$"):
        key = value[1:]
        if key not in params:
            raise JobError("unknown_parameter", "unknown parameter reference", {"name": key})
        return float(params[key])
    raise JobError("invalid_value", "expected a number or $parameter", {"value": repr(value)})


def vector(value, params, size=3):
    if not isinstance(value, list) or len(value) != size:
        raise JobError("invalid_vector", "expected %d coordinates" % size)
    return [number(item, params) for item in value]


def axis_vector(axis, params=None):
    import FreeCAD as App
    mapping = {"x": (1.0, 0.0, 0.0), "y": (0.0, 1.0, 0.0), "z": (0.0, 0.0, 1.0)}
    if axis not in mapping:
        raise JobError("invalid_axis", "axis must be x, y or z", {"axis": axis})
    return App.Vector(*mapping[axis])


def polygon_wire(points, params, vec):
    import Part
    coords = [vector(point, params, 2) for point in points]
    vertices = [vec(x, y, 0.0) for x, y in coords]
    if len(vertices) < 3:
        raise JobError("invalid_profile", "a profile needs at least 3 points")
    vertices.append(vertices[0])
    return Part.makePolygon(vertices)


def orient(shape, axis, vec):
    """Rotate an XY-plane construction so its extrusion axis becomes `axis`."""
    origin = vec(0, 0, 0)
    if axis == "z":
        return shape
    if axis == "x":
        shape.rotate(origin, vec(0, 1, 0), 90.0)
    else:
        shape.rotate(origin, vec(1, 0, 0), -90.0)
    return shape


def resolve_positions(feature, params):
    if "positions" in feature:
        return [vector(item, params) for item in feature["positions"]]
    grid = feature.get("grid") or {}
    origin = vector(grid["origin"], params)
    step_x = number(grid["step_x"], params)
    step_y = number(grid["step_y"], params)
    count_x = int(number(grid["count_x"], params))
    count_y = int(number(grid["count_y"], params))
    if count_x < 1 or count_y < 1 or count_x * count_y > 256:
        raise JobError("invalid_grid", "grid counts must be positive and produce at most 256 holes")
    positions = []
    for row in range(count_y):
        for col in range(count_x):
            positions.append([origin[0] + col * step_x, origin[1] + row * step_y, origin[2]])
    return positions


def selected_edges(shape, feature):
    wanted = feature.get("edge_ids")
    if wanted is None:
        return list(shape.Edges)
    edges = []
    for index in wanted:
        if not isinstance(index, int) or index < 0 or index >= len(shape.Edges):
            raise JobError("invalid_edge", "edge index out of range", {"index": index})
        edges.append(shape.Edges[index])
    return edges


def build_document(document, limits):
    import FreeCAD as App
    import Part

    vec = App.Vector
    params = document.get("parameters", {})
    shapes = {}
    steps = []

    for feature in document.get("features", []):
        op = feature.get("op")
        fid = feature.get("id")
        try:
            if op == "box":
                shape = Part.makeBox(
                    number(feature["length"], params),
                    number(feature["width"], params),
                    number(feature["height"], params),
                    vec(*vector(feature.get("at", [0, 0, 0]), params)),
                )
            elif op == "cylinder":
                shape = Part.makeCylinder(
                    number(feature["radius"], params),
                    number(feature["height"], params),
                    vec(*vector(feature.get("at", [0, 0, 0]), params)),
                    axis_vector(feature.get("axis", "z")),
                )
            elif op == "sphere":
                shape = Part.makeSphere(
                    number(feature["radius"], params),
                    vec(*vector(feature.get("at", [0, 0, 0]), params)),
                )
            elif op == "cone":
                shape = Part.makeCone(
                    number(feature["radius1"], params),
                    number(feature["radius2"], params),
                    number(feature["height"], params),
                    vec(*vector(feature.get("at", [0, 0, 0]), params)),
                    axis_vector(feature.get("axis", "z")),
                )
            elif op == "torus":
                shape = Part.makeTorus(
                    number(feature["radius1"], params),
                    number(feature["radius2"], params),
                    vec(*vector(feature.get("at", [0, 0, 0]), params)),
                    axis_vector(feature.get("axis", "z")),
                )
            elif op == "polygon_extrude":
                axis = feature.get("axis", "z")
                wire = polygon_wire(feature["points"], params, vec)
                face = Part.Face(wire)
                shape = face.extrude(vec(0, 0, number(feature["height"], params)))
                shape = orient(shape, axis, vec)
                at = vector(feature.get("at", [0, 0, 0]), params)
                shape.translate(vec(*at))
            elif op == "revolve":
                axis = feature.get("axis", "z")
                wire = polygon_wire(feature["points"], params, vec)
                face = Part.Face(wire)
                shape = face.revolve(
                    vec(0, 0, 0), vec(0, 0, 1), number(feature["angle"], params)
                )
                shape = orient(shape, axis, vec)
                at = vector(feature.get("at", [0, 0, 0]), params)
                shape.translate(vec(*at))
            elif op == "boolean":
                parts = [shapes[ref] for ref in feature["parts"]]
                mode = feature["mode"]
                if mode == "union":
                    shape = parts[0].multiFuse(parts[1:]) if len(parts) > 2 else parts[0].fuse(parts[1])
                elif mode == "cut":
                    tool = parts[1].multiFuse(parts[2:]) if len(parts) > 2 else parts[1]
                    shape = parts[0].cut(tool)
                else:
                    shape = parts[0]
                    for other in parts[1:]:
                        shape = shape.common(other)
            elif op in ("hole", "hole_pattern"):
                source = shapes[feature["on"]]
                positions = [vector(feature["at"], params)] if op == "hole" else resolve_positions(feature, params)
                diameter = number(feature["diameter"], params)
                depth = number(feature.get("depth", 0), params)
                if depth <= 0:
                    box = source.BoundBox
                    depth = max(box.XLength, box.YLength, box.ZLength, 1.0) * 2.0
                direction = axis_vector(feature.get("axis", "z"))
                tools = [
                    Part.makeCylinder(diameter / 2.0, depth, vec(*position), direction)
                    for position in positions
                ]
                cutter = tools[0].multiFuse(tools[1:]) if len(tools) > 1 else tools[0]
                shape = source.cut(cutter)
            elif op in ("fillet", "chamfer"):
                source = shapes[feature["on"]]
                edges = selected_edges(source, feature)
                if op == "fillet":
                    shape = source.makeFillet(number(feature["radius"], params), edges)
                else:
                    shape = source.makeChamfer(number(feature["size"], params), edges)
            elif op == "shell":
                source = shapes[feature["on"]]
                faces = [source.Faces[i] for i in feature.get("faces", [])]
                if not faces:
                    faces = [source.Faces[-1]]
                shape = source.makeThickness(faces, -number(feature["thickness"], params), 1e-3)
            elif op == "transform":
                shape = shapes[feature["on"]].copy()
                if "translate" in feature:
                    shape.translate(vec(*vector(feature["translate"], params)))
                if "rotate" in feature:
                    rotation = vector(feature["rotate"], params, 4)
                    shape.rotate(vec(0, 0, 0), vec(rotation[0], rotation[1], rotation[2]), rotation[3])
                if "mirror" in feature:
                    shape.mirror(vec(0, 0, 0), vec(*vector(feature["mirror"], params)))
                if "scale" in feature:
                    shape.scale(number(feature["scale"], params))
            else:
                raise JobError("unknown_op", "unsupported operation", {"op": op})

            if shape.isNull():
                raise JobError("null_shape", "operation produced an empty shape")
            shapes[fid] = shape
            steps.append({
                "id": fid,
                "op": op,
                "solids": len(shape.Solids),
                "volume": round(float(shape.Volume), 6),
            })
        except JobError:
            raise
        except Exception as exc:
            raise JobError(
                "feature_failed",
                "FreeCAD could not apply feature %s (%s): %s" % (fid, op, exc),
                {"feature": fid, "op": op, "exception": str(exc)},
            )

    result_id = document.get("result")
    if result_id not in shapes:
        raise JobError("missing_result", "the result feature does not exist", {"result": result_id})
    return shapes[result_id], steps


# --------------------------------------------------------------------------
# Reporting, preview, export
# --------------------------------------------------------------------------

def geometry_report(shape, steps, limits):
    box = shape.BoundBox
    mins = [float(box.XMin), float(box.YMin), float(box.ZMin)]
    maxs = [float(box.XMax), float(box.YMax), float(box.ZMax)]
    size = [maxs[i] - mins[i] for i in range(3)]
    # Boolean results are often Part.Compound, which has no CenterOfMass.
    try:
        center = [float(shape.CenterOfMass.x), float(shape.CenterOfMass.y), float(shape.CenterOfMass.z)]
    except Exception:
        try:
            com = shape.Solids[0].CenterOfMass
            center = [float(com.x), float(com.y), float(com.z)]
        except Exception:
            center = [(mins[i] + maxs[i]) / 2.0 for i in range(3)]
    valid = bool(shape.isValid())
    max_box = float(limits.get("maxBoundingBoxMm", 2000))
    checks = [
        {"id": "valid", "ok": valid, "detail": "BRep is valid"},
        {"id": "non_empty", "ok": not shape.isNull(), "detail": "shape is not null"},
        {"id": "has_solid", "ok": len(shape.Solids) >= 1, "detail": "%d solid(s)" % len(shape.Solids)},
        {"id": "positive_volume", "ok": float(shape.Volume) > 0, "detail": "volume %.6f mm^3" % float(shape.Volume)},
        {"id": "bounded", "ok": max(size) <= max_box, "detail": "max extent %.3f mm (limit %.0f)" % (max(size), max_box)},
    ]
    return {
        "units": "mm",
        "valid": valid and all(item["ok"] for item in checks),
        "volume": round(float(shape.Volume), 6),
        "area": round(float(shape.Area), 6),
        "bbox": {"min": mins, "max": maxs, "size": size},
        "center_of_mass": center,
        "topology": {
            "solids": len(shape.Solids),
            "faces": len(shape.Faces),
            "edges": len(shape.Edges),
            "vertices": len(shape.Vertexes),
        },
        "checks": checks,
        "steps": steps,
    }


def projection_views(shape, max_points):
    """Collect discretized edge polylines for four orthographic-ish views."""
    def front(p):
        return [p.x, p.z]

    def top(p):
        return [p.x, p.y]

    def right(p):
        return [p.y, p.z]

    def iso(p):
        return [(p.x - p.y) * 0.8660254, p.z + (p.x + p.y) * 0.5]

    views = {"front": [], "top": [], "right": [], "iso": []}
    projectors = {"front": front, "top": top, "right": right, "iso": iso}
    total = 0
    for edge in shape.Edges:
        try:
            points = edge.discretize(Number=16)
        except Exception:
            points = [vertex.Point for vertex in edge.Vertexes]
        if len(points) < 2:
            continue
        if total + len(points) > max_points:
            break
        total += len(points)
        for name, project in projectors.items():
            views[name].append([[round(value, 5) for value in project(point)] for point in points])
    return views


def export_shape(shape, path, fmt, limits):
    import Part
    if fmt in ("step", "stp"):
        shape.exportStep(path)
    elif fmt in ("iges", "igs"):
        shape.exportIges(path)
    elif fmt in ("brep", "brp"):
        shape.exportBrep(path)
    elif fmt == "stl":
        try:
            shape.exportStl(path)
        except Exception:
            import MeshPart
            mesh = MeshPart.meshFromShape(
                Shape=shape, LinearDeflection=0.1, AngularDeflection=0.5, Relative=False
            )
            mesh.write(path)
    else:
        raise JobError("unsupported_format", "unsupported export format", {"format": fmt})

    with open(path, "rb") as handle:
        data = handle.read()
    max_bytes = int(limits.get("maxArtifactBytes", 134217728))
    if len(data) > max_bytes:
        os.remove(path)
        raise JobError("too_large", "exported artifact exceeds the byte limit", {
            "bytes": len(data), "limit": max_bytes,
        })
    return {
        "path": path,
        "format": fmt,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def import_shape(path, fmt):
    import Part
    if fmt not in ("step", "stp", "iges", "igs", "brep", "brp"):
        raise JobError("unsupported_format", "import supports STEP, IGES and BREP only", {"format": fmt})
    try:
        shape = Part.read(path)
    except Exception:
        shape = Part.Shape()
        shape.read(path)
    if shape.isNull():
        raise JobError("empty_import", "the imported file contains no geometry")
    return shape


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def main():
    try:
        job = load_job()
    except JobError as exc:
        fail(exc.code, str(exc), exc.details)
        return
    except Exception as exc:
        fail("job_read_failed", "cannot read job file", {"message": str(exc)})
        return

    op = job.get("op", "probe")
    limits = job.get("limits", {}) or {}

    if op == "probe":
        import FreeCAD as App
        modules = {}
        for name in ("Part", "Mesh", "MeshPart", "Draft", "Import"):
            try:
                __import__(name)
                modules[name] = True
            except Exception:
                modules[name] = False
        emit({
            "success": True,
            "version": list(App.Version()),
            "python": sys.version.split()[0],
            "platform": sys.platform,
            "modules": modules,
            "capabilities": {
                "modeling": "declarative DSL",
                "import": ["step", "iges", "brep"],
                "export": ["step", "iges", "stl", "brep"],
            },
        })
        return

    try:
        if op == "build":
            shape, steps = build_document(job.get("document") or {}, limits)
        elif op == "import":
            shape = import_shape(job.get("path", ""), job.get("format", ""))
            steps = [{"id": "import", "op": "import", "solids": len(shape.Solids), "volume": round(float(shape.Volume), 6)}]
        else:
            raise JobError("unknown_op", "unknown runner operation", {"op": op})

        report = geometry_report(shape, steps, limits)
        payload = {"success": True, "report": report}

        if job.get("preview", False):
            payload["views"] = projection_views(shape, int(limits.get("maxPreviewPoints", 20000)))

        target = job.get("export")
        if target:
            payload["artifact"] = export_shape(shape, target["path"], target["format"], limits)

        emit(payload)
    except JobError as exc:
        fail(exc.code, str(exc), exc.details)
    except Exception as exc:
        fail("runner_exception", "unexpected runner failure: %s" % exc, {
            "exception": str(exc),
            "traceback": traceback.format_exc(limit=6),
        })


# FreeCADCmd executes the file as a module named after the file (e.g.
# "freecad_runner"), NOT as "__main__". An `if __name__ == "__main__"` guard
# would silently do nothing, so the entry point must be called unconditionally.
main()
