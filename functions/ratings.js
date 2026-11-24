// Direct title links for the Collection info badges. No search-page redirects.
// A supplied Sheet URL still wins in the client. This lookup handles blank
// cells, using exact normalized titles plus year/type/cast to avoid remakes.
const KEEP=7*24*3600;
const inflight=new Map();

function text(value){
  return String(value||'').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{
    const cp=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);
    return cp>0&&cp<=0x10ffff?String.fromCodePoint(cp):'';
  }).replace(/&(amp|quot|apos|lt|gt|nbsp);/g,(_,n)=>({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '})[n]);
}
function normalize(value){
  return text(value).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase()
    .replace(/&/g,' and ').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/^(the|an|a) /,'');
}
function cleanTitle(value){
  return value.replace(/\s*\((?:unrated|extended|theatrical|director.s cut|uncut)(?: edition| version| cut)?\)\s*$/i,'').trim();
}
function details(params){
  const title=cleanTitle(params.get('title')||'');
  const alt=cleanTitle(params.get('alt')||'');
  const season=/\s*:\s*Season\s+0*(\d+)\b.*$/i.exec(title);
  const tv=/television|tv/i.test(params.get('media')||'') || !!season;
  const base=s=>tv?s.replace(/\s*:\s*Season\s+\d+\b.*$/i,'').trim():s;
  const titles=[...new Set([base(title),base(alt)].filter(Boolean))];
  const cast=(params.get('cast')||'').split(',').map(n=>normalize(n.replace(/\s*\([IVXLCDM]+\)\s*$/i,''))).filter(Boolean);
  return {titles,names:new Set(titles.map(normalize)),year:Number(params.get('year'))||0,tv,season:Number(season?.[1])||0,cast};
}
function castOverlap(cast,expected){
  const names=String(cast||'').split(',').map(normalize);
  return names.some(n=>n && expected.includes(n));
}
function choose(candidates,movie){
  const matches=candidates.filter(c=>movie.names.has(normalize(c.title)) && c.tv===movie.tv &&
    (movie.year ? (c.year===movie.year || (castOverlap(c.cast,movie.cast) && Math.abs(c.year-movie.year)<=1) ||
      (movie.tv && movie.season && c.year>0 && c.year<=movie.year && (!c.end || c.end>=movie.year))) : true));
  const exact=matches.filter(c=>c.year===movie.year);
  const pool=exact.length?exact:matches;
  const cast=pool.filter(c=>castOverlap(c.cast,movie.cast));
  const unique=[...new Map((cast.length?cast:pool).map(c=>[c.url,c])).values()];
  return unique.length===1?unique[0].url:'';
}
async function get(url){
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),9000);
  try{
    // Workers supports manual/follow, but not the standard "error" mode.
    const response=await fetch(url,{
      signal:ctl.signal,
      redirect:'manual',
      headers:{
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept':'application/json,text/html,*/*'
      }
    });
    if(!response.ok) throw new Error('Rating service unavailable ('+response.status+')');
    return await response.text();
  }finally{clearTimeout(timer);}
}
function imdbSuggestionUrl(rawTitle){
  const slug=rawTitle.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  const first=/^[a-z0-9]/.test(slug)?slug[0]:'x';
  return 'https://v3.sg.media-imdb.com/suggestion/'+first+'/'+encodeURIComponent(slug||rawTitle.toLowerCase())+'.json';
}
export function imdbCandidates(json){
  return (json.d||[]).filter(c=>/^tt\d+$/.test(c.id)).map(c=>({
    title:c.l,year:Number(c.y)||0,tv:/^tv(Series|MiniSeries|Episode)$/.test(c.qid),cast:c.s,
    url:'https://www.imdb.com/title/'+c.id+'/'
  }));
}
export function rtCandidates(html){
  const out=[];
  for(const [,attrs,body] of html.matchAll(/<search-page-media-row\b([^>]*)>([\s\S]*?)<\/search-page-media-row>/g)){
    const a=Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],text(m[2])]));
    const link=[...body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].find(m=>/slot="title"/.test(m[1]));
    const href=link && /href="([^"]+)"/.exec(link[1]);
    if(!href) continue;
    let url;try{url=new URL(text(href[1]),'https://www.rottentomatoes.com');}catch{continue;}
    if(url.origin!=='https://www.rottentomatoes.com' || !/^\/(m|tv)\/[^/]+\/?$/.test(url.pathname)) continue;
    const tv=url.pathname.startsWith('/tv/');
    out.push({title:text(link[2].replace(/<[^>]*>/g,'')).trim(),url:url.href,tv,cast:a.cast,
      year:Number(tv?(a['start-year']||a.startyear):(a['release-year']||a.releaseyear))||0,
      end:Number(a['end-year']||a.endyear)||0});
  }
  return out;
}
export async function resolveRatings(params){
  const movie=details(params);
  const query=encodeURIComponent(movie.titles[0]);
  const results=await Promise.allSettled([
    get(imdbSuggestionUrl(movie.titles[0])).then(s=>choose(imdbCandidates(JSON.parse(s)),movie)),
    get('https://www.rottentomatoes.com/search?search='+query).then(s=>choose(rtCandidates(s),movie))
  ]);
  for(const [i,result]of results.entries())if(result.status==='rejected'){
    console.warn('[rating-links]',i===0?'IMDb':'Rotten Tomatoes',result.reason?.message||'Lookup failed');
  }
  return {
    imdbUrl:results[0].status==='fulfilled'?results[0].value:'',
    rtUrl:results[1].status==='fulfilled'?results[1].value:'',
    imdbErr:results[0].status==='rejected'?String(results[0].reason):(results[0].value?'ok':'fulfilled-empty')
  };
}
export async function onRequestGet({request,waitUntil}){
  const url=new URL(request.url),params=url.searchParams;
  if(!params.get('title') || (params.get('title')||'').length>200 || (params.get('alt')||'').length>200 ||
    (params.get('cast')||'').length>1500 || (params.get('media')||'').length>40 || !/^\d{0,4}$/.test(params.get('year')||'')){
    return new Response('Invalid movie',{status:400});
  }
  const ordered=new URLSearchParams();
  for(const key of ['title','alt','year','media','cast']) ordered.set(key,params.get(key)||'');
  const key=new Request(url.origin+'/__rating-links/v3?'+ordered);
  const cache=globalThis.caches?.default;
  const hit=cache && await cache.match(key);
  if(hit) return hit;
  let pending=inflight.get(key.url);
  if(!pending){pending=resolveRatings(ordered);inflight.set(key.url,pending);pending.finally(()=>inflight.delete(key.url));}
  const links=await pending;
  const response=Response.json(links,{headers:{'Cache-Control':'public, max-age='+(links.imdbUrl && links.rtUrl?KEEP:300)}});
  if(cache) waitUntil(cache.put(key,response.clone()));
  return response;
}
