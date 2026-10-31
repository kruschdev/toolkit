"""
SQLAlchemy session factory — mirrors @krusch/toolkit/db concepts for PostgreSQL.

Provides a clean factory pattern for creating database engines and sessions,
with connection health checking and context-managed sessions.

Usage:
    from krusch_toolkit.db import create_engine_from_config, create_session_factory

    engine = create_engine_from_config({
        'host': 'localhost', 'port': 5432,
        'name': 'myapp', 'user': 'myapp', 'password': 'secret',
    })
    SessionLocal = create_session_factory(engine)

    # In request handlers:
    with get_session(SessionLocal) as db:
        users = db.query(User).all()
"""

import logging
from contextlib import contextmanager
from typing import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker, DeclarativeBase

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    """Shared declarative base for all toolkit-managed models."""
    pass


def create_engine_from_config(
    config: dict,
    *,
    pool_size: int = 5,
    max_overflow: int = 10,
    echo: bool = False,
) -> Engine:
    """
    Create a SQLAlchemy engine from a config dict.

    Args:
        config: Database config with keys:
            - host: Database host
            - port: Database port (default 5432)
            - name: Database name
            - user: Database user
            - password: Database password
        pool_size: Connection pool size (default 5)
        max_overflow: Max overflow connections (default 10)
        echo: Echo SQL to logger (default False)

    Returns:
        SQLAlchemy Engine
    """
    host = config.get('host', 'localhost')
    port = config.get('port', 5432)
    name = config.get('name', config.get('database', 'app'))
    user = config.get('user', 'app')
    password = config.get('password', '')

    url = f"postgresql://{user}:{password}@{host}:{port}/{name}"

    engine = create_engine(
        url,
        pool_size=pool_size,
        max_overflow=max_overflow,
        pool_pre_ping=True,  # Verify connections before use
        echo=echo,
    )

    logger.info(f"Database engine created: {user}@{host}:{port}/{name}")
    return engine


def create_session_factory(engine: Engine) -> sessionmaker:
    """
    Create a scoped session factory bound to an engine.

    Args:
        engine: SQLAlchemy Engine

    Returns:
        sessionmaker instance — call it to get a Session
    """
    return sessionmaker(bind=engine, autocommit=False, autoflush=False)


@contextmanager
def get_session(session_factory: sessionmaker) -> Generator[Session, None, None]:
    """
    Context-managed session that auto-commits on success, rolls back on error.

    Usage:
        with get_session(SessionLocal) as db:
            db.add(user)
            # auto-commits on exit, rolls back on exception

    Args:
        session_factory: sessionmaker instance

    Yields:
        SQLAlchemy Session
    """
    session = session_factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def check_health(engine: Engine) -> bool:
    """
    Verify database connectivity with a simple query.

    Args:
        engine: SQLAlchemy Engine

    Returns:
        True if the database is reachable, False otherwise
    """
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception as e:
        logger.error(f"Database health check failed: {e}")
        return False


def init_tables(engine: Engine) -> None:
    """
    Create all tables defined on the shared Base.

    Args:
        engine: SQLAlchemy Engine
    """
    Base.metadata.create_all(bind=engine)
    logger.info("Database tables initialized")


def init_db(
    database_url: str | None = None,
    *,
    pool_size: int = 5,
    max_overflow: int = 10,
    echo: bool = False,
) -> Engine:
    """
    Initialize a SQLAlchemy Engine from an explicit database_url or DATABASE_URL env var (BUG-01).
    Raises ConfigurationError when DATABASE_URL is missing or empty.
    """
    import os
    from krusch_toolkit.config import ConfigurationError

    raw_url = database_url if database_url is not None else os.getenv("DATABASE_URL")
    db_url = raw_url.strip() if isinstance(raw_url, str) else ""
    if not db_url:
        raise ConfigurationError("DATABASE_URL is required for database connection")

    if db_url.startswith("sqlite"):
        return create_engine(db_url, echo=echo)

    return create_engine(
        db_url,
        pool_size=pool_size,
        max_overflow=max_overflow,
        pool_pre_ping=True,
        echo=echo,
    )

