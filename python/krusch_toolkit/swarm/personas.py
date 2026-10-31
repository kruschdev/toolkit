"""
Persona Hub Engine Utilities
Combines pure Homelab '.agent/skills' personas with Hivemind PostgreSQL 'Elite Personas'.
"""
import os
import re
import random
import logging
from typing import List, Dict

from krusch_toolkit.swarm.db_bridge import db_bridge, ElitePersona

logger = logging.getLogger(__name__)

HOMELAB_SKILLS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".agent", "skills"))

def fetch_local_homelab_personas() -> List[Dict[str, str]]:
    """
    Parses frontmatter from local SKILL.md files.
    """
    personas = []
    
    if not os.path.exists(HOMELAB_SKILLS_DIR):
        logger.warning(f"Could not find homelab skills dir: {HOMELAB_SKILLS_DIR}")
        return personas
        
    EXCLUDED_SKILLS = {"factory-worker", "builder-manager", "homelab-deploy", "homelab-expert"}
    
    for skill_name in os.listdir(HOMELAB_SKILLS_DIR):
        if skill_name in EXCLUDED_SKILLS:
            continue
            
        skill_dir = os.path.join(HOMELAB_SKILLS_DIR, skill_name)
        if os.path.isdir(skill_dir):
            skill_md = os.path.join(skill_dir, "SKILL.md")
            if os.path.isfile(skill_md):
                with open(skill_md, "r", encoding="utf-8") as f:
                    content = f.read()
                    name_match = re.search(r'^name:\s*(.+)$', content, re.MULTILINE)
                    desc_match = re.search(r'^description:\s*(.+)$', content, re.MULTILINE)
                    
                    if name_match and desc_match:
                        personas.append({
                            "title": f"Homelab: {name_match.group(1).strip()}",
                            "description": desc_match.group(1).strip()
                        })
    return personas

def fetch_hivemind_elite_personas(limit: int = 4) -> List[Dict[str, str]]:
    """
    Randomly fetches Elite Tech Personas from the local Hivemind PostgreSQL database.
    """
    personas = []
    session = db_bridge.SessionLocal()
    try:
        from sqlalchemy.sql.expression import func
        # ORDER BY RANDOM() LIMIT X
        results = session.query(ElitePersona).order_by(func.random()).limit(limit).all()
        for row in results:
            personas.append({
                "title": row.persona_title,
                "description": row.persona_description
            })
    except Exception as e:
        logger.error(f"Failed to fetch elite personas from DB: {e}")
    finally:
        session.close()
        
    return personas

def get_prompt_roster() -> str:
    """
    Assembles a mixed roster of 1 homelab persona and 4 hivemind elite personas.
    """
    roster_parts = []
    
    local_personas = fetch_local_homelab_personas()
    if local_personas:
        chosen_local = random.choice(local_personas)
        roster_parts.append(f"- [\"{chosen_local['title']}\"]: {chosen_local['description']}")
        
    elite_personas = fetch_hivemind_elite_personas(limit=4)
    for p in elite_personas:
        roster_parts.append(f"- [\"{p['title']}\"]: {p['description']}")
        
    return "\n".join(roster_parts)

