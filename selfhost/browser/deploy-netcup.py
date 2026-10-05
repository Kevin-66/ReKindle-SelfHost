#!/usr/bin/env python3
"""Install the Z-Library overlay and private browser in an existing Kubernetes app.
Run on the cluster host with this directory's bundle present. No secrets are printed.
Reapply after a platform redeploy, or remove the overlay after deploying the updated
Docker image (which includes Chromium and Xvfb itself).
"""
import argparse, datetime, json, os, pathlib, re, subprocess

p=argparse.ArgumentParser()
p.add_argument('--namespace',required=True)
p.add_argument('--deployment',required=True)
p.add_argument('--bundle',required=True)
a=p.parse_args(); base=pathlib.Path(a.bundle)
def kube(*args,input=None):
    return subprocess.check_output(['kubectl',*args],input=input).decode()
def apply(obj):
    return kube('create','-f','-',input=json.dumps(obj).encode())
dep=json.loads(kube('get','deployment','-n',a.namespace,a.deployment,'-o','json'))
spec=dep['spec']['template']['spec']
app=next(c for c in spec['containers'] if c['name']=='rekindle')
browser_env=[e for e in app.get('env',[]) if e['name']=='ZLIBRARY_PROXY_URL']
selector=','.join(k+'='+v for k,v in dep['spec']['selector']['matchLabels'].items())
pods=json.loads(kube('get','pods','-n',a.namespace,'-l',selector,'-o','json'))['items']
pod=next(x['metadata']['name'] for x in pods if any(c.get('type')=='Ready' and c.get('status')=='True' for c in x.get('status',{}).get('conditions',[])))
def read_live(path):
    code='process.stdout.write(require("fs").readFileSync('+json.dumps(path)+',"utf8"))'
    return kube('exec','-n',a.namespace,pod,'-c',app['name'],'--','node','-e',code)
# Keep a private rollback snapshot on the cluster host, including existing env.
backup=pathlib.Path('/var/lib/rekindle-zlibrary')
backup.mkdir(mode=0o700,exist_ok=True)
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
path=backup/(stamp+'-deployment.json')
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f: json.dump(dep,f)

api=read_live('/app/selfhost/server/src/api.js')
if "from './zlibrary.js'" not in api:
    found=re.search(r"^import .* from '\./images\.js';$",api,re.M)
    assert found, "Image import anchor not found"
    needle=found.group(0)
    api=api.replace(needle,needle+"\nimport { listBooks } from './zlibrary.js';")
    needle="        if (section === 'img') return await handleImage(req, res, url);"
    assert needle in api
    api=api.replace(needle,needle+"""
        if (section === 'zlibrary') {
            if (req.method !== 'GET') return send(res, 405, { error: { code: 'invalid-argument', message: 'Use GET' } });
            rateLimit(req, 'zlibrary', 30, 60000);
            return send(res, 200, await listBooks(url.searchParams.get('q') || '', Number(url.searchParams.get('page') || 1)));
        }""")
data={'api.js':api,'zlibrary.js':(base/'zlibrary.js').read_text(),'zlibrary-browser.js':(base/'zlibrary-browser.js').read_text(),'zlibrary.html':(base/'zlibrary.html').read_text(),'service.mjs':(base/'service.mjs').read_text()}
mounts=[('api.js','/app/selfhost/server/src/api.js'),('zlibrary.js','/app/selfhost/server/src/zlibrary.js'),('zlibrary-browser.js','/app/selfhost/server/src/zlibrary-browser.js')]
for variant in ['main','lite','legacy']:
    icons=read_live('/app/site/'+variant+'/icons.js')
    icons += """
;(function(){if(typeof APPS!=='undefined'&&!APPS.some(function(a){return a.id==='zlibrary';}))APPS.push({id:'zlibrary',name:'Z-Library',cat:'lifestyle',desc:'Explore popular books, search Z-Library and save books for later.',icon:'<path d="M4 5 H14 L16 7 L18 5 H28 V26 H18 L16 28 L14 26 H4 Z M16 7 V28 M7 10 H12 M7 15 H12 M20 10 H25 M20 15 H25" fill="none" stroke="black" stroke-width="2"/>'});})();
"""
    key=variant+'-icons.js';data[key]=icons
    mounts.extend([(key,'/app/site/'+variant+'/icons.js'),('zlibrary.html','/app/site/'+variant+'/zlibrary.html')])
name='rekindle-zlibrary-'+stamp.lower()
print(apply({'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':name,'namespace':a.namespace,'labels':{'app.kubernetes.io/part-of':'rekindle-zlibrary'}},'data':data}),end='')
app['env']=[e for e in app.get('env',[]) if e['name']!='ZLIBRARY_BROWSER_ENDPOINT']+[{'name':'ZLIBRARY_BROWSER_ENDPOINT','value':'http://127.0.0.1:8091'}]
app['volumeMounts']=[m for m in app.get('volumeMounts',[]) if m['name']!='zlibrary-code']+[{'name':'zlibrary-code','mountPath':dest,'subPath':key,'readOnly':True} for key,dest in mounts]
health=['node','-e',"fetch('http://127.0.0.1:8091/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
browser={'name':'zlibrary-browser','image':'mcr.microsoft.com/playwright:v1.63.0-noble','command':['sh','-c','mkdir -p /tmp/app && cd /tmp/app && npm install --no-audit --no-fund playwright-core@1.63.0 && cp /browser-code/service.mjs ./service.mjs && cp /browser-code/zlibrary-browser.js ./zlibrary-browser.mjs && xvfb-run -a --server-args="-screen 0 1280x800x24" node service.mjs; exit $?'],'env':browser_env+[{'name':'HOME','value':'/tmp/app'}],'securityContext':{'runAsUser':1000,'runAsGroup':1000,'runAsNonRoot':True,'allowPrivilegeEscalation':False,'capabilities':{'drop':['ALL']}},'resources':{'requests':{'cpu':'100m','memory':'256Mi'},'limits':{'cpu':'2','memory':'1536Mi'}},'volumeMounts':[{'name':'zlibrary-code','mountPath':'/browser-code','readOnly':True},{'name':'zlibrary-shm','mountPath':'/dev/shm'},{'name':'zlibrary-no-api','mountPath':'/var/run/secrets/kubernetes.io/serviceaccount','readOnly':True}],'livenessProbe':{'exec':{'command':health},'initialDelaySeconds':60,'periodSeconds':30,'failureThreshold':3}}
spec['containers']=[c for c in spec['containers'] if c['name']!='zlibrary-browser']+[browser]
spec['volumes']=[v for v in spec.get('volumes',[]) if v['name'] not in ['zlibrary-code','zlibrary-shm','zlibrary-no-api']]+[{'name':'zlibrary-code','configMap':{'name':name}},{'name':'zlibrary-shm','emptyDir':{'medium':'Memory','sizeLimit':'256Mi'}},{'name':'zlibrary-no-api','emptyDir':{}}]
# JSON patch changes only this pod template and rejects a concurrent rollout.
patch=[{'op':'test','path':'/metadata/resourceVersion','value':dep['metadata']['resourceVersion']},{'op':'replace','path':'/spec/template/spec','value':spec}]
print(kube('patch','deployment','-n',a.namespace,a.deployment,'--type=json','--patch-file=/dev/stdin',input=json.dumps(patch).encode()),end='')
print('Rollback snapshot:',path)
