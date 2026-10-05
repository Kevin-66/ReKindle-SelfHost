import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { catalogueUrl, parseCatalogue, listBooks } from '../src/zlibrary.js';
import { transformJs } from '../src/transform.js';

const card = '<z-bookcard href="/book/abc/example.html" language="English" year="2010" extension="epub" filesize="398 KB" publisher="Publisher" isbn="123"><div slot="title">Pride &amp; Prejudice</div><div slot="author">Jane Austen</div></z-bookcard>';
const result = '<div id="searchResultBox">' + card + '</div>';

test('search encoding and invalid inputs', () => {
 assert.equal(catalogueUrl('A/B & 中文',2),'https://z-lib.sk/s/A%2FB%20%26%20%E4%B8%AD%E6%96%87?page=2');
 for(const page of [0,-1,1.5,NaN,1001]) assert.throws(()=>catalogueUrl('a',page));
 assert.throws(()=>catalogueUrl('x'.repeat(201),1));
});
test('parses metadata, pagination and skips hidden, duplicate and unsafe books', () => {
 const html = result + '<div hidden>' + card.replace('/abc/','/hidden/') + '</div>' +
 '<div aria-hidden="true">'+card.replace('/abc/','/hidden2/')+'</div>' + card +
 card.replace('/book/abc/example.html','https://evil.example/book/a/b.html') +
 '<a href="/s/test?page=2">2</a>';
 const data = parseCatalogue(html,catalogueUrl('test',1));
 assert.equal(data.books.length,1); assert.equal(data.hasNext,true);
 assert.equal(data.books[0].title,'Pride & Prejudice'); assert.equal(data.books[0].extension,'epub');
 assert.equal(data.books[0].author,'Jane Austen'); assert.equal(data.books[0].year,'2010');
});
test('popular covers, true empty results and upstream blocks', () => {
 assert.equal(parseCatalogue('<a href="/book/a/b.html"><z-cover title="Example" author="Author"></z-cover></a>',catalogueUrl()).books.length,1);
 assert.deepEqual(parseCatalogue('<div id="searchResultBox"></div>',catalogueUrl('none')).books,[]);
 for(const html of ['<title>Access Denied | DiamWall</title>', '<h1>Sign in</h1>', '<div id="searchResultBox"></div><iframe src="/.well-known/diamwall/test"></iframe>']) assert.throws(()=>parseCatalogue(html,catalogueUrl('a')));
});
test('never follows external redirects', async () => {
 let calls=0;
 await assert.rejects(listBooks('redirect-test',1,async()=>{calls++; return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});}),/could not be loaded/);
 assert.equal(calls,1);
});
test('same-origin cookie redirect, cache and concurrent deduplication', async () => {
 let calls=0;
 const fetcher=async(url,init)=>{
  calls++;
  if(calls===1) return new Response(null,{status:307,headers:{location:url,'set-cookie':'public=1; Path=/; Secure'}});
  assert.equal(init.headers.Cookie,'public=1'); return new Response(result);
 };
 const [a,b]=await Promise.all([listBooks('cache-test',1,fetcher),listBooks('cache-test',1,fetcher)]);
 assert.equal(a.books.length,1); assert.deepEqual(a,b);
 await listBooks('cache-test',1,fetcher); assert.equal(calls,2);
});
test('redirect loops are bounded and large responses rejected', async () => {
 let calls=0;
 await assert.rejects(listBooks('loop-test',1,async(url)=>{calls++; return new Response(null,{status:307,headers:{location:url}});}));
 assert.equal(calls,4);
 await assert.rejects(listBooks('large-test',1,async()=>new Response('x'.repeat(3*1024*1024+1))));
});
test('long Retry-After is respected without retrying', async () => {
 let calls=0;
 await assert.rejects(listBooks('rate-test',1,async()=>{calls++;return new Response(null,{status:429,headers:{'Retry-After':'120'}});}));
 assert.equal(calls,1);
});
test('launcher integration and browser script syntax', () => {
 const context=vm.createContext({});
 vm.runInContext(transformJs('var APPS = [];','icons.js'),context);
 vm.runInContext(transformJs('','icons-beta.js'),context);
 assert.equal(context.APPS.filter(a=>a.id==='zlibrary').length,1);
 const html=fs.readFileSync(new URL('../../site/zlibrary.html',import.meta.url),'utf8');
 for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  new vm.Script(match[1]); assert.doesNotMatch(match[1],/\?\.|\?\?/);
 }
});


test('DiamWall browser verification is reported without retrying', async () => {
 let calls = 0;
 await assert.rejects(listBooks('verification-test', 1, async () => {
  calls++; return new Response('<title>Verifying your browser | DiamWall</title>', {status:513});
 }), /requires browser verification/);
 assert.equal(calls, 1);
});

test('browser network allowlist and proxy credentials separation', async () => {
 const {allowedBrowserUrl,browserProxy}=await import('../src/zlibrary-browser.js');
 for(const url of ['https://z-lib.sk/','https://cdn.diamwall.com/script.js','https://s3.cdn-zlib.sk/cover']) assert.equal(allowedBrowserUrl(url),true);
 for(const url of ['http://z-lib.sk/','https://127.0.0.1/','https://z-lib.sk.evil.test/','file:///etc/passwd','https://user:pass@z-lib.sk/','https://z-lib.sk:8443/']) assert.equal(allowedBrowserUrl(url),false);
 assert.deepEqual(browserProxy('http://test:p%40ss@proxy.example:3128'),{server:'http://proxy.example:3128',username:'test',password:'p@ss'});
 assert.throws(()=>browserProxy('socks5://proxy.example:1080'));
});

test('browser loader results are parsed and cached', async () => {
 const {rawFetch}=await import('../src/netguard.js');
 let calls=0;
 const loader=async()=>{calls++;return result;};
 const data=await listBooks('browser-loader-test',1,rawFetch,loader);
 assert.equal(data.books[0].title,'Pride & Prejudice');
 await listBooks('browser-loader-test',1,rawFetch,loader);
 assert.equal(calls,1);
});
