from __future__ import annotations

import os
import sys
from pathlib import Path

import uvicorn

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.env import ensure_qbr_env

ensure_qbr_env()


def main() -> None:
    os.environ["QBR_AUTO_WORKER"] = "0"
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True, app_dir=str(BACKEND_DIR))


if __name__ == "__main__":
    main()
