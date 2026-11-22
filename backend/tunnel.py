import pinggy
import time
import sys
import os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3001

try:
    print(f"Starting tunnel for port {PORT}...", flush=True)
    tunnel = pinggy.start_tunnel(forwardto=PORT)
    
    # Wait for URLs
    for _ in range(15):
        if tunnel.urls:
            break
        time.sleep(0.5)

    if not tunnel.urls:
        print("ERROR: Failed to obtain public URLs from pinggy", flush=True)
        sys.exit(1)

    # Prefer https
    https_urls = [u for u in tunnel.urls if u.startswith("https://")]
    public_url = https_urls[0] if https_urls else tunnel.urls[0]

    print(f"TUNNEL_READY={public_url}", flush=True)

    # Write URL to a local file for convenience
    url_file = os.path.join(os.path.dirname(__file__), ".tunnel_url")
    with open(url_file, "w", encoding="utf-8") as f:
        f.write(public_url)

    # Keep the tunnel alive
    tunnel.wait()
except Exception as e:
    print(f"ERROR: {e}", flush=True)
    sys.exit(1)
