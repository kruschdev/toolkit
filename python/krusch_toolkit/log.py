"""
Structured JSON logging — extracted from Pocket Lawyer's production patterns.

Sets up rotating file handlers with JSON formatting, plus optional
GlitchTip/Sentry error tracking. Every log entry is a parseable JSON object.

Usage:
    from krusch_toolkit.log import setup_logging, setup_error_tracking

    setup_logging('my-app')                     # JSON to logs/app.log + stderr
    setup_error_tracking('https://dsn@...')      # Optional Sentry/GlitchTip
"""

import json
import logging
import logging.handlers
import os
from datetime import datetime, timezone


class JSONFormatter(logging.Formatter):
    """
    Format log records as JSON for structured logging and admin dashboard parsing.

    Output format:
        {"timestamp": "...", "level": "INFO", "logger": "...", "message": "...",
         "module": "...", "line": 42, "request_id": "..."}
    """

    def format(self, record: logging.LogRecord) -> str:
        log_data = {
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
            'module': record.module,
            'line': record.lineno,
        }

        if record.exc_info:
            log_data['exception'] = self.formatException(record.exc_info)

        # Include request_id if attached to the record
        if hasattr(record, 'request_id'):
            log_data['request_id'] = record.request_id

        return json.dumps(log_data)


def setup_logging(
    app_name: str,
    log_dir: str = 'logs',
    *,
    level: int = logging.INFO,
    max_bytes: int = 10 * 1024 * 1024,  # 10MB
    backup_count: int = 5,
    console: bool = True,
) -> logging.Logger:
    """
    Configure structured JSON logging with rotating file handlers.

    Creates two log files:
        - {log_dir}/app.log    — all messages at `level` and above
        - {log_dir}/error.log  — ERROR and above only

    Args:
        app_name: Application name (used as root logger name)
        log_dir: Directory for log files (created if needed)
        level: Minimum log level (default INFO)
        max_bytes: Max size per log file before rotation (default 10MB)
        backup_count: Number of rotated backups to keep (default 5)
        console: Also log to stderr (default True)

    Returns:
        Configured root logger
    """
    os.makedirs(log_dir, exist_ok=True)

    json_formatter = JSONFormatter()
    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    # Clear any existing handlers to avoid duplicates
    root_logger.handlers.clear()

    # App log — all messages
    app_handler = logging.handlers.RotatingFileHandler(
        os.path.join(log_dir, 'app.log'),
        maxBytes=max_bytes,
        backupCount=backup_count,
    )
    app_handler.setFormatter(json_formatter)
    app_handler.setLevel(level)
    root_logger.addHandler(app_handler)

    # Error log — errors only
    error_handler = logging.handlers.RotatingFileHandler(
        os.path.join(log_dir, 'error.log'),
        maxBytes=max_bytes,
        backupCount=backup_count,
    )
    error_handler.setFormatter(json_formatter)
    error_handler.setLevel(logging.ERROR)
    root_logger.addHandler(error_handler)

    # Console handler
    if console:
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(logging.Formatter(
            f'%(asctime)s [{app_name}] %(levelname)s %(name)s: %(message)s',
            datefmt='%H:%M:%S',
        ))
        console_handler.setLevel(level)
        root_logger.addHandler(console_handler)

    root_logger.info(f"{app_name} logging initialized (dir={log_dir})")
    return root_logger


def setup_error_tracking(dsn: str, app_name: str = '', **kwargs) -> bool:
    """
    Initialize Sentry/GlitchTip error tracking (optional).

    Args:
        dsn: Sentry/GlitchTip DSN URL
        app_name: Application name for Sentry release tag
        **kwargs: Additional sentry_sdk.init() arguments

    Returns:
        True if initialized, False if sentry_sdk is not installed
    """
    if not dsn:
        return False

    try:
        import sentry_sdk
        from sentry_sdk.integrations.flask import FlaskIntegration

        sentry_sdk.init(
            dsn=dsn,
            integrations=[FlaskIntegration()],
            traces_sample_rate=kwargs.pop('traces_sample_rate', 0.1),
            release=app_name or None,
            **kwargs,
        )
        logging.getLogger(__name__).info(f"Error tracking initialized: {dsn[:40]}...")
        return True
    except ImportError:
        logging.getLogger(__name__).warning("sentry_sdk not installed — error tracking disabled")
        return False
