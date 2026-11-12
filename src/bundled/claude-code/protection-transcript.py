"""Replay an immutable transcript snapshot, one bounded response per request."""
import base64
import json
import os
import sys
import tempfile

with open(os.path.expanduser(sys.argv[1]), 'rb') as source, tempfile.TemporaryFile() as snapshot:
    remaining = os.fstat(source.fileno()).st_size
    size = remaining
    while remaining:
        piece = source.read(min(65536, remaining))
        if not piece:
            raise ValueError('Transcript changed while it was being read')
        snapshot.write(piece)
        remaining -= len(piece)
    snapshot.flush()
    print(json.dumps({'bytes': size}), flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        if set(request) != {'id', 'offset'} or type(request['offset']) is not int or not 0 <= request['offset'] <= size:
            raise ValueError('Invalid transcript read')
        snapshot.seek(request['offset'])
        piece = snapshot.read(65536)
        offset = request['offset'] + len(piece)
        print(json.dumps({'id':request['id'], 'data':base64.b64encode(piece).decode(), 'offset':offset, 'done':offset == size}), flush=True)
