export const OLLAMA_HOSTS = {
  kruschdev_director: process.env.HIVEMIND_HOST_DIRECTOR || 'http://kruschdev:5440', // Hivemind Brain API (replaces RTX 3060 Ollama instance)
  kruschdev_worker: process.env.OLLAMA_HOST_WORKER || 'http://127.0.0.1:11435',     // RX 5500 (8GB)
  kruschgame: process.env.OLLAMA_HOST_GAME || 'http://10.0.0.19:11434',             // RTX 3050 (4GB)
  kruschserv: process.env.OLLAMA_HOST_SERV || 'http://10.0.0.85:11434',             // GTX 970 (4GB)
  krmac13: 'http://10.0.0.183:11434',
  kr1yoga: 'http://10.0.0.228:11434'
};

export const HARDWARE_MODELS = {
    // Port 5440 on Kruschdev Node => Hivemind Brain API Endpoint (OpenAI Compat)
    DIRECTOR: 'hivemind-brain',
    
    // Port 11435 on Kruschdev Node (8GB VRAM - RX 5500) => High Parameter Offload
    WORKER: 'yi-coder:9b',
    
    // 4GB VRAM Tiers (RTX 3050 & GTX 970) => Fast Component execution
    EDGE_FAST: 'qwen2.5-coder:1.5b',
    EDGE_EXPERT: 'qwen2.5-coder:3b',
    
    // CPU Fallback logic
    CPU_ONLY: 'qwen2.5-coder:14b-cpu'
};
