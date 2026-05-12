from __future__ import annotations

import os

import uvicorn


def main() -> None:
    os.environ["QBR_AUTO_WORKER"] = "0"
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True, app_dir="backend")


if __name__ == "__main__":
    main()
