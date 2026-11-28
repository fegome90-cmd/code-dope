"""Independent Draft7 comparison; not the cfworker npm package."""
import itertools, json, subprocess
from pathlib import Path
from jsonschema import Draft7Validator
schema=json.loads(Path('request.schema.json').read_text())
Draft7Validator.check_schema(schema)
validator=Draft7Validator(schema)
values=[None,[],{},False,1, 'direct']
for v, route, telem in itertools.product([1,2,'1',None,True], ['direct','native','worker','inline','pool','auto','__proto__',None], [None,'minimal','extended','off',False]):
    values.append({'schemaVersion':v,'route':route,'telemetry':telem})
values += [{'schemaVersion':1,'route':r} for r in schema['properties']['route']['enum']]
values += [{'schemaVersion':1,'route':'direct',k:True} for k in ['mode','policy','allowedRoutes','__proto__','constructor','prelude']]
values += [{'schemaVersion':1},{'route':'direct'},{'schemaVersion':1,'route':'direct','telemetry':'minimal','extra':1}]
raw=[json.dumps(x,ensure_ascii=False,separators=(',',':')) for x in values]
code="""import {parseRequest,requestSchema} from './selection.mjs';import {readFileSync} from 'node:fs';const cases=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({schema:requestSchema,valid:cases.map(x=>{try{parseRequest(x);return true}catch{return false}})}));"""
r=subprocess.run(['node','--input-type=module','-e',code],input=json.dumps(raw),text=True,capture_output=True,check=True)
result=json.loads(r.stdout)
assert result['schema']==schema,'schema must be generated from selection.mjs'
expected=[validator.is_valid(x) for x in values]
assert result['valid']==expected,[(x,a,b) for x,a,b in zip(values,result['valid'],expected) if a!=b]
print(f'Draft7 schema parity: {len(values)}/{len(values)} cases; {sum(expected)} accepted, {len(values)-sum(expected)} rejected; no mismatches.')
print('JSON Schema is shape only; raw byte limit and host authorization are separate runtime checks.')
