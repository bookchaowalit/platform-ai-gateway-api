"""Opt-in disposable real platform-data process. Explicit local admin DSN only.

The Node test supplies only synthetic verification/configuration values. Resource
lifetime is bounded by stdin; the isolated database/role are dropped on exit.
"""
import json
import os
import socket
import sys
import threading
import time
from uuid import UUID

import uvicorn
from platform_backend_core import Database, TokenVerifier
from platform_backend_core.migrations import MigrationRunner
from platform_backend_core.testing import temporary_database
from platform_data.app import create_app
from platform_data.migrations import MIGRATIONS

config = json.loads(sys.stdin.readline())
with temporary_database(os.environ['AI_GATEWAY_TEST_PG_DSN'], prefix='ai_test_') as fixture:
    MigrationRunner(fixture.admin_dsn, namespace='data').apply(MIGRATIONS)
    fixture.grant_schema('public')
    database = Database(fixture.runtime_dsn, max_size=8)
    app = create_app(database, TokenVerifier(issuer=config['issuer'], audience='platform-api', public_key=config['public_key']), system_workspace=UUID(config['system_workspace']))
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level='error', access_log=False))
    thread = threading.Thread(target=server.run, kwargs={'sockets': [sock]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started:
        if time.monotonic() > deadline or not thread.is_alive():
            raise RuntimeError('Local data server did not start')
        time.sleep(0.01)
    print(json.dumps({'url': f'http://127.0.0.1:{port}'}), flush=True)
    try:
        sys.stdin.read()
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        sock.close()
        database.close()
