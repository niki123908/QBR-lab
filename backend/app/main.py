from __future__ import annotations

import os
import threading

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router as api_router
from app.core.db import DATABASE_URL, init_db
from app.core.errors import AppError


def _should_start_embedded_worker() -> bool:
    """Optional in-process worker for SQLite-only single-process dev (uvicorn without worker/)."""
    flag = str(os.getenv("QBR_AUTO_WORKER", "0")).strip().lower()
    if flag not in {"1", "true", "yes", "on"}:
        return False
    return DATABASE_URL.startswith("sqlite")


def _start_embedded_worker(app: FastAPI) -> None:
    if not _should_start_embedded_worker():
        return
    if getattr(app.state, "embedded_worker_thread", None) is not None:
        return

    from worker.jobs.worker_main import run_worker_loop

    stop_event = threading.Event()
    worker_id = f"embedded-worker-{os.getpid()}"
    thread = threading.Thread(
        target=run_worker_loop,
        kwargs={"stop_event": stop_event, "worker_id": worker_id},
        daemon=True,
        name="qbr-embedded-worker",
    )
    thread.start()
    app.state.embedded_worker_stop_event = stop_event
    app.state.embedded_worker_thread = thread


def create_app() -> FastAPI:
    app = FastAPI(title="QBR Platform API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(api_router, prefix="/api")

    @app.on_event("startup")
    def startup_init_db() -> None:
        init_db()
        _start_embedded_worker(app)

    @app.on_event("shutdown")
    def shutdown_embedded_worker() -> None:
        stop_event = getattr(app.state, "embedded_worker_stop_event", None)
        thread = getattr(app.state, "embedded_worker_thread", None)
        if stop_event is not None:
            stop_event.set()
        if thread is not None:
            thread.join(timeout=2)

    @app.exception_handler(AppError)
    async def app_error_handler(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"message": exc.message})

    @app.exception_handler(Exception)
    async def unhandled_error_handler(_: Request, __: Exception) -> JSONResponse:
        # Global concise message policy for the project.
        return JSONResponse(status_code=500, content={"message": "Failed."})

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
