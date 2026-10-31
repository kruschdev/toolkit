"""
Database integration for Swarm Blueprints.
Maps blueprints to the `appdb` PostgreSQL database.
"""
import json
import logging
from typing import Dict, Any, Optional
from datetime import datetime

from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker

from krusch_toolkit.config import load_project_config

logger = logging.getLogger(__name__)

Base = declarative_base()

class BlueprintState(Base):
    """
    SQLAlchemy model for storing the deterministic assembly instructions.
    """
    __tablename__ = 'blueprints'

    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(String(255), unique=True, index=True, nullable=False)
    status = Column(String(50), nullable=False, default="AWAITING_ASSEMBLY")
    payload = Column(Text, nullable=False)  # JSON String of the Pydantic model
    error_log = Column(Text, nullable=True)  # TSCL PSDD Error bubbling
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class ElitePersona(Base):
    """
    SQLAlchemy model for storing Tencent PersonaHub database records.
    """
    __tablename__ = 'tbl_elite_personas'

    id = Column(Integer, primary_key=True, autoincrement=True)
    persona_title = Column(String(255), nullable=False)
    persona_description = Column(Text, nullable=False)

class DBBridge:
    def __init__(self, config: Optional[Dict[str, Any]] = None):
        """
        Initializes the DB Bridge connecting specifically to the 'appdb' database.
        """
        if config is None:
            config = load_project_config()
            
        import os
        url = os.environ.get('DATABASE_URL')
        if not url:
            host = config.get('db_host', 'localhost')
            port = config.get('db_port', 5432)
            user = config.get('db_user', 'app')
            password = config.get('db_password', '')
            name = config.get('db_name', 'appdb')  # Default application database
            url = f"postgresql://{user}:{password}@{host}:{port}/{name}"
        else:
            if url.startswith("postgres://"):
                url = url.replace("postgres://", "postgresql://", 1)
        
        self.engine = create_engine(url, pool_pre_ping=True, echo=False)
        self.SessionLocal = sessionmaker(bind=self.engine, autocommit=False, autoflush=False)
        
    def init_db(self):
        """Creates the tables if they don't exist."""
        Base.metadata.create_all(bind=self.engine)
        logger.info("Application database schema initialized.")

    def commit_blueprint(self, task_id: str, blueprint_json: str) -> bool:
        """
        Commits a validated blueprint JSON string to the database.
        """
        session = self.SessionLocal()
        try:
            blueprint = BlueprintState(
                task_id=task_id,
                status="AWAITING_ASSEMBLY",
                payload=blueprint_json
            )
            session.add(blueprint)
            session.commit()
            logger.info(f"Blueprint {task_id} successfully committed to database.")
            return True
        except Exception as e:
            session.rollback()
            logger.error(f"Failed to commit blueprint {task_id}: {e}")
            return False
        finally:
            session.close()

# Global singleton for ease of use
db_bridge = DBBridge()
