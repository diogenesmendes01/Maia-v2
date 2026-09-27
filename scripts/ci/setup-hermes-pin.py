#!/usr/bin/env python3
"""Fresh, isolated CI installation of Maia's real Hermes pin (no user profiles)."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def main():
    pin = json.loads(Path(__file__).with_name("hermes-pin.json").read_text())
    if not re.fullmatch(r"[0-9a-f]{40}", pin["sha"]):
        raise ValueError("Hermes pin must be a full commit SHA")
    if ".".join(map(str, sys.version_info[:2])) != pin["python"]:
        raise ValueError("Hermes pin requires Python " + pin["python"])
    target = Path(sys.argv[1]).resolve()
    # Refuse reuse, including an existing installation or a shared cache.
    target.mkdir(parents=True, exist_ok=False)
    env = {"PATH": os.environ["PATH"], "HOME": str(target / "home"),
           "HERMES_HOME": str(target / "hermes-home"),
           "UV_CACHE_DIR": str(target / "cache"),
           "UV_PYTHON_DOWNLOADS": "never", "PYTHONNOUSERSITE": "1"}
    Path(env["HOME"]).mkdir()
    upstream = target / "upstream"

    def run(*args, **kwargs):
        return subprocess.run(args, env=env, check=True, **kwargs)

    run("git", "init", str(upstream))
    run("git", "-C", str(upstream), "fetch", "--depth=1", pin["repository"], pin["sha"])
    run("git", "-C", str(upstream), "checkout", "--detach", "FETCH_HEAD")
    actual = run("git", "-C", str(upstream), "rev-parse", "HEAD",
                 capture_output=True, text=True).stdout.strip()
    if actual != pin["sha"]:
        raise ValueError("Hermes checkout differs from the required pin")
    run(sys.executable, "-m", "venv", str(target / "installer"))
    installer = str(target / "installer/bin/python")
    run(installer, "-m", "pip", "install", "--disable-pip-version-check", "uv==" + pin["uv"])
    # Consume the upstream's committed transitive lock, never re-resolve it.
    run(installer, "-m", "uv", "sync", "--frozen", "--no-dev", "--python", sys.executable,
        "--project", str(upstream))
    python = str(upstream / ".venv/bin/python")
    run(installer, "-m", "uv", "pip", "check", "--python", python)
    # Import the real engine, not a fixture or the machine's installed Hermes.
    run(python, "-c", "from pathlib import Path; import run_agent; "
        "from run_agent import AIAgent; "
        "assert Path(run_agent.__file__).resolve().parent == Path.cwd(); "
        "print('Real pinned AIAgent import OK')", cwd=upstream)
    outputs = f"python={python}\nupstream={upstream}\nsha={actual}\n"
    (target / "outputs.env").write_text(outputs)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
            stream.write(outputs)
    print(outputs, end="")


if __name__ == "__main__":
    main()
