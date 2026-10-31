"""
@module system
Hardware and thermal monitoring utilities for Linux compute hosts.
"""

import subprocess
import re

def get_liquid_temp():
    """
    Get the liquid temperature from the AIO cooler via liquidctl.
    Currently supports Corsair H100i series AIO coolers via liquidctl.
    
    Returns:
        float or None: Liquid temperature in Celsius, or None if unreadable.
    """
    try:
        result = subprocess.run(
            ['liquidctl', '--match', 'H100i', 'status'],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        output = result.stdout
        match = re.search(r'Liquid temperature\s+([\d.]+)', output)
        if match:
            return float(match.group(1))
        return None
    except Exception as e:
        # Non-critical: some nodes may not have liquidctl or the H100i
        return None

def check_thermal_safety(max_liquid_temp=43, silent=False):
    """
    Check if the system is within safe thermal operating limits.
    Default threshold is 43.0°C (liquid).
    
    Args:
        max_liquid_temp (float): Liquid temperature threshold in Celsius.
        silent (bool): If True, returns Boolean instead of raising Exception.
        
    Returns:
        bool: True if safe, False if unsafe (only if silent=True).
        
    Raises:
        RuntimeError: If temperature exceeds threshold and silent is False.
    """
    temp = get_liquid_temp()
    
    if temp is None:
        return True # Assume safe if sensor is missing
        
    if temp > max_liquid_temp:
        if silent:
            return False
        raise RuntimeError(f"THERMAL ALERT: Liquid temperature is {temp}°C (Threshold: {max_liquid_temp}°C). Please offload workload or maximize fans.")
        
    return True
