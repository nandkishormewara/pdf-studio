class ToolError(Exception):
    """A user-facing processing error with an HTTP status."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


class ToolUnavailable(ToolError):
    def __init__(self, message: str):
        super().__init__(message, status=503)
