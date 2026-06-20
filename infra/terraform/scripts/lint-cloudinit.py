#!/usr/bin/env python3
"""Lint the cloud-init Terraform template without applying Terraform.

The Deploy workflow is the only thing that exercises `templatefile()` + a real
boot, and each cold deploy is ~25min — so template/boot bugs (e.g. an unescaped
`${VAR}` in a comment, or invalid cloud-config YAML) historically only surfaced
live. This renders the .tftpl exactly the way `templatefile()` would and checks:

  1. every `${...}` interpolation references a var the templatefile() call
     actually passes (an unescaped `${TOWNHOUSE_HOME}` in a comment fails here —
     `templatefile` interpolates everywhere, comments included);
  2. the rendered output is valid YAML, for BOTH the debug and non-debug paths
     of the `%{ if debug_ssh_pubkey != "" }` directive;
  3. each embedded `*.sh` write_files script is extracted to OUT_DIR so the
     workflow can run shellcheck over it.

Usage: lint-cloudinit.py [OUT_DIR]   (OUT_DIR default: ./_cloudinit_scripts)
Exit non-zero on any problem.
"""
import os
import re
import sys

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required (pip install pyyaml)")

HERE = os.path.dirname(os.path.abspath(__file__))
TF_DIR = os.path.dirname(HERE)
TFTPL = os.path.join(TF_DIR, "cloud-init.yaml.tftpl")
INSTANCE_TF = os.path.join(TF_DIR, "instance.tf")

errors = []


def allowed_vars():
    """Vars the templatefile() call passes, parsed from instance.tf (no drift)."""
    src = open(INSTANCE_TF).read()
    m = re.search(r"templatefile\([^,]+,\s*\{(.*?)\}\s*\)\s*\)", src, re.S)
    if not m:
        errors.append("instance.tf: could not find the templatefile({...}) map")
        return set()
    return set(re.findall(r"(\w+)\s*=", m.group(1)))


def render(src, allowed, debug):
    """Mimic templatefile(): resolve `%{ if }`, `${var}`, and `$${...}` escapes."""
    if debug:
        # Keep the conditional block body, drop only the directive markers.
        src = re.sub(r"%\{\s*if[^}]*~\}", "", src)
        src = re.sub(r"%\{\s*endif\s*~\}", "", src)
    else:
        # Drop the whole `%{ if ... ~} ... %{ endif ~}` block.
        src = re.sub(r"%\{\s*if.*?~\}.*?%\{\s*endif\s*~\}", "", src, flags=re.S)
    # Protect `$${` escapes (literal `${` at runtime) before resolving vars.
    src = src.replace("$${", "\x00")
    src = re.sub(r"\$\{(\w+)\}", lambda m: "x" if m.group(1) in allowed else m.group(0), src)
    return src.replace("\x00", "${")


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.getcwd(), "_cloudinit_scripts")
    if not os.path.exists(TFTPL):
        sys.exit(f"template not found: {TFTPL}")
    raw = open(TFTPL).read()
    allowed = allowed_vars()
    print(f"templatefile() vars: {sorted(allowed)}")

    # 1. Unknown interpolations (unescaped `${X}` where X is not a passed var).
    unknown = sorted(
        {m.group(1) for m in re.finditer(r"(?<!\$)\$\{(\w+)\}", raw) if m.group(1) not in allowed}
    )
    # Also catch `${foo.bar}`-style (non-word) unescaped interpolations.
    dotted = sorted(
        {m.group(1) for m in re.finditer(r"(?<!\$)\$\{([^}]+)\}", raw)
         if not re.fullmatch(r"\w+", m.group(1))}
    )
    if unknown:
        errors.append(f"unescaped ${{...}} referencing unknown vars (escape as $${{...}} or pass them): {unknown}")
    if dotted:
        errors.append(f"unescaped ${{...}} expressions (escape as $${{...}}): {dotted}")

    # 2. Valid YAML for both render paths + 3. extract scripts (from non-debug).
    scripts = {}
    for debug in (False, True):
        label = "debug" if debug else "non-debug"
        try:
            doc = yaml.safe_load(render(raw, allowed, debug))
        except yaml.YAMLError as e:
            errors.append(f"rendered cloud-config is not valid YAML ({label} path): {e}")
            continue
        if not isinstance(doc, dict) or "write_files" not in doc:
            errors.append(f"rendered cloud-config missing write_files ({label} path)")
            continue
        if not debug:
            for f in doc["write_files"]:
                p = f.get("path", "")
                if p.endswith(".sh"):
                    scripts[os.path.basename(p)] = f.get("content", "")

    if not scripts:
        errors.append("no embedded *.sh scripts found to shellcheck")

    os.makedirs(out_dir, exist_ok=True)
    for name, content in scripts.items():
        with open(os.path.join(out_dir, name), "w") as fh:
            fh.write(content)
    print(f"extracted {len(scripts)} script(s) to {out_dir}: {sorted(scripts)}")

    if errors:
        print("\nFAIL — cloud-init lint found problems:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)
    print("OK — template renders, YAML valid (both paths), scripts extracted")


if __name__ == "__main__":
    main()
