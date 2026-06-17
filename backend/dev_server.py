from __future__ import annotations

import sys
from pathlib import Path

import uvicorn

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.env import ensure_qbr_env

ensure_qbr_env()


def main() -> None:
    # Watch only backend Python sources — not storage/artifacts (workers write constantly).
    reload_dirs = [str(BACKEND_DIR / "app")]
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        app_dir=str(BACKEND_DIR),
        reload_dirs=reload_dirs,
    )


if __name__ == "__main__":
    main()
