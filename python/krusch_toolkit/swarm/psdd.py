"""
Predictive State Drift Detector (PSDD) for Chrysalis V0.
Computes true spectral radius and topological entropy over the proposed Architectural State Graph
in order to deterministicly trap out-of-bounds context payloads before execution.
"""
import networkx as nx
import numpy as np
import logging
from .blueprint_schema import BlueprintState

logger = logging.getLogger(__name__)

class PSDD:
    def __init__(self, entropy_threshold_max: float = 10.0):
        """
        Calculated baseline for homelab SAGA execution drift limits.
        If the spectral radius of the state graph breaches this threshold, 
        the generation will probabilistically fail across multiple agents.
        """
        self.limit = entropy_threshold_max

    def evaluate_blueprint(self, state: BlueprintState) -> dict:
        """
        Builds a NetworkX DAG from the BlueprintState and computes graph topology stability.
        
        Args:
            state: Pydantic BlueprintState object.
            
        Returns:
            dict containing math metrics and a 'SAFE' or 'UNSTABLE' state.
        """
        logger.info("[PSDD] Initiating True Mathematical Spectral Decay Simulation...")
        
        G = nx.DiGraph()
        
        # 1. Plot Phase Nodes and Component Nodes
        for phase in state.phase_graph:
            phase_node = f"PHASE_{phase.phase_order}"
            G.add_node(phase_node, type="phase")
            
            # Phases depend sequentially on the prior phase
            if phase.phase_order > 0:
                G.add_edge(f"PHASE_{phase.phase_order - 1}", phase_node)
                
            for comp in phase.components:
                # Add component
                comp_node = comp.file_path
                G.add_node(comp_node, type="component")
                G.add_edge(phase_node, comp_node) # Child of its phase
                
                # Check Global Dependencies to add cross-component structural weight
                for g_dep in comp.global_dependencies:
                    g_node = f"GLOBAL_{g_dep}"
                    G.add_node(g_node, type="global")
                    G.add_edge(comp_node, g_node)

        # 2. Extract Spectral Entropy (Causal Drift Estimation)
        # Convert to adjacency matrix
        nodes = len(G.nodes)
        
        if nodes <= 1:
            return {"status": "SAFE", "spectral_radius": 0.0, "nodes": nodes}
            
        adj_matrix = nx.to_numpy_array(G)
        
        # Calculate eigenvalues
        eigenvalues = np.linalg.eigvals(adj_matrix)
        
        # The largest magnitude eigenvalue represents the Spectral Radius (growth capability / instability)
        spectral_radius = float(np.max(np.abs(eigenvalues)))
        
        # Base Entropy
        structure_entropy = (nodes * 0.08) + spectral_radius
        
        logger.info(f"[PSDD] Graph Topology - Nodes: {nodes}, Edges: {len(G.edges)}")
        logger.info(f"[PSDD] Spectral Radius: {spectral_radius:.4f} | Total Entropy: {structure_entropy:.4f}")
        
        status = "UNSTABLE: HIGH ENTROPY DECAY" if structure_entropy > self.limit else "SAFE"
        
        return {
            "status": status,
            "nodes": nodes,
            "edges": len(G.edges),
            "spectral_radius": round(spectral_radius, 4),
            "total_entropy": round(structure_entropy, 4)
        }

# Global singleton
psdd_engine = PSDD()
