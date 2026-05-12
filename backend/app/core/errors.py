class AppError(Exception):
    """Application error with concise user-facing message."""

    def __init__(self, message: str = "Failed.", status_code: int = 400) -> None:
        self.message = message
        self.status_code = status_code
        super().__init__(message)
