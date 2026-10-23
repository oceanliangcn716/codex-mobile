#!/usr/bin/python3
"""Copy a private pairing link without printing it or passing it as an argument."""
import ipaddress
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent
configuration = json.loads((root / 'config.json').read_text())
address = configuration.get('bind_host', 'auto')
if address == 'auto':
    address = None
    for interface in ('en0', 'en1', 'en2'):
        result = subprocess.run(['/usr/sbin/ipconfig', 'getifaddr', interface], capture_output=True, text=True)
        candidate = result.stdout.strip()
        try:
            if ipaddress.ip_address(candidate).is_private:
                address = candidate
                break
        except ValueError:
            pass
if not address:
    sys.exit('没有找到 Mac 的局域网地址，请先连接家庭网络。')
token = (root / 'private' / 'pair.secret').read_text().strip()
link = f'http://{address}:{configuration["port"]}/#pair={token}'
subprocess.run(['/usr/bin/pbcopy'], input=link.encode(), check=True)
print('Codex 手机专属链接已复制。')
print('请在 iPhone Safari 粘贴打开；首次连接后，可添加到主屏幕。')
print('外出时请通过 Tailscale 或其他私人 VPN 连接回局域网。')
print('链接能控制这台 Mac，请只留给自己的设备。')
