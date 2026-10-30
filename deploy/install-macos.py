#!/usr/bin/env python3
"""Install Cairn for the current macOS user, using their Node 24 and a private env file. No sudo."""
import argparse
import os
import plistlib
import shutil
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--node', default=shutil.which('node'))
parser.add_argument('--env', default=str(Path.home() / '.config/cairn/cairn.env'))
parser.add_argument('--logs', default=str(Path.home() / 'Library/Logs/Cairn'))
parser.add_argument('--prepare-only', action='store_true', help='Write the service without starting it')
args = parser.parse_args()
if not args.node:
    parser.error('Node.js 24 or later is required; pass its path with --node')
node = Path(args.node).resolve()
version = subprocess.check_output([str(node), '--version'], text=True).strip()
if int(version.lstrip('v').split('.')[0]) < 24:
    parser.error('Node.js 24 or later is required')
env = Path(args.env).expanduser().resolve()
info = env.stat()
if not env.is_file() or info.st_uid != os.getuid() or info.st_mode & 0o077:
    parser.error('the env file must be owned by this user and mode 600')
root = Path(__file__).resolve().parent.parent
logs = Path(args.logs).expanduser().resolve()
logs.mkdir(parents=True, exist_ok=True, mode=0o700)
label = 'com.cairn.bot'
service = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
service.parent.mkdir(parents=True, exist_ok=True)
spec = {
    'Label': label,
    'ProgramArguments': [str(node), str(root / 'deploy/launch.mjs'), str(env), str(logs)],
    'WorkingDirectory': str(root),
    'RunAtLoad': True,
    'KeepAlive': {'SuccessfulExit': False},
    'ThrottleInterval': 10,
    'ExitTimeOut': 10,
    'ProcessType': 'Background',
    'Umask': 0o077,
    'StandardOutPath': '/dev/null',
    'StandardErrorPath': str(logs / 'supervisor.log'),
}
# Refuse to replace a service pointing at an unrelated application.
if service.exists():
    old = plistlib.loads(service.read_bytes())
    if old.get('Label') != label or not any(str(x).endswith('/deploy/launch.mjs') for x in old.get('ProgramArguments', [])):
        parser.error('existing com.cairn.bot service has an unrecognised owner; inspect it before replacing')
service.write_bytes(plistlib.dumps(spec))
service.chmod(0o600)
if args.prepare_only:
    print('Prepared ' + str(service))
else:
    target = 'gui/' + str(os.getuid())
    # Replace only this application's prior service, preserving its private SQLite data.
    subprocess.run(['launchctl', 'bootout', target + '/' + label], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['launchctl', 'bootstrap', target, str(service)], check=True)
    print('Started ' + label + '; inspect logs in ' + str(logs))
