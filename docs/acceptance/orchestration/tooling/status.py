import json
from pathlib import Path
from datetime import datetime
import sys
p=Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/truckdeck-orchestration/cursor.log')
items=[]
for line in p.read_text().splitlines():
 try:e=json.loads(line)
 except ValueError:continue
 if e.get('type')=='assistant':
  for c in e.get('message',{}).get('content',[]):
   if c.get('type')=='text':items.append(c.get('text','')[:1600])
 elif e.get('type')=='tool_call' and e.get('subtype')=='started':
  for k,v in e.get('tool_call',{}).items():
   if isinstance(v,dict):
    a=v.get('args',{});items.append(k+': '+str(a.get('path',a.get('description',a.get('command',a.get('name','')))))[:300])
 elif e.get('type')=='result':items.append(str(e)[:7000])
print('Updated',datetime.fromtimestamp(p.stat().st_mtime),'Now',datetime.now())
print('\n'.join(items[-8:]))
