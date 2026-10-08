import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Application, CareerDiscovery, JobOffer, OfferSearchCriteria, OfferSearchService, RunMode } from '../src/shared/career.ts';
import { careerUrl, CareerError, CareerStore } from './career-store.ts';
import { Vault } from './vault.ts';
import { CareerAI } from './career-ai.ts';

export interface CareerApiContext {
  store: CareerStore;
  vault: Vault;
  ai?: CareerAI;
  browser?: { discover?: CareerDiscovery['discover'] };
  runner: { start(id:string,mode:RunMode,credentialId?:string):Application; resume?(id:string,credentialId?:string,fileFieldKey?:string,resumeId?:string):Application; isBusy():boolean; hasPausedSession?():boolean; stop():Promise<void> };
  discovery: CareerDiscovery;
  offerSearch?: OfferSearchService;
  publicOfferSearch?: OfferSearchService;
  demo: boolean;
  allowTestAutomation?: boolean;
  allowedTestOrigins?: string[];
}
const reply=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new CareerError(400,'validation','Objet JSON attendu.');return v as Record<string,unknown>;};
const string=(v:unknown,name:string,max=10000)=>{if(typeof v!=='string'||v.length>max)throw new CareerError(400,'validation',`${name} invalide.`);return v;};
const fields=(v:Record<string,unknown>,keys:string[])=>{for(const k of Object.keys(v))if(!keys.includes(k))throw new CareerError(400,'validation',`Champ interdit : ${k}.`);};
async function json(req:IncomingMessage,max=1_000_000):Promise<Record<string,unknown>> {if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'')))throw new CareerError(400,'validation','Contenu JSON attendu.');const length=Number(req.headers['content-length']||0);if(length>max)throw new CareerError(413,'too_large','Requête trop volumineuse.');const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>max)throw new CareerError(413,'too_large','Requête trop volumineuse.');chunks.push(b);}try{return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(e){if(e instanceof CareerError)throw e;throw new CareerError(400,'validation','JSON invalide.');}}
const noDemo=(ctx:CareerApiContext,operation:string,targetUrl?:string)=>{if(!ctx.demo)return;if(!ctx.allowTestAutomation||!ctx.allowedTestOrigins?.length||(targetUrl&&!ctx.allowedTestOrigins.includes(new URL(targetUrl).origin)))throw new CareerError(403,'demo_disabled',`${operation} désactivé en démonstration.`);};
const safeFilename=(name:string)=>name.replace(/[\r\n"\\/\x00-\x1f\x7f]/g,'_').slice(0,150)||'cv';
const contentDisposition=(name:string)=>{const clean=safeFilename(name),ascii=clean.replace(/[^\x20-\x7e]/g,'_');return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;};
function decodeResumeBase64(value:unknown):Buffer {
  const encoded=string(value,'CV',14_000_000);
  if(encoded.length===0||encoded.length%4!==0)throw new CareerError(400,'validation','Base64 invalide.');
  let padding=0;
  if(encoded.endsWith('=='))padding=2;else if(encoded.endsWith('='))padding=1;
  const decodedLength=encoded.length/4*3-padding;
  if(decodedLength>10*1024*1024)throw new CareerError(413,'too_large','CV limité à 10 Mio.');
  for(let i=0;i<encoded.length-padding;i++){const c=encoded.charCodeAt(i);if(!((c>=65&&c<=90)||(c>=97&&c<=122)||(c>=48&&c<=57)||c===43||c===47))throw new CareerError(400,'validation','Base64 invalide.');}
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.length!==decodedLength||bytes.toString('base64')!==encoded)throw new CareerError(400,'validation','Base64 invalide.');
  return bytes;
}

export async function handleCareerApi(req:IncomingMessage,res:ServerResponse,url:URL,context:CareerApiContext):Promise<boolean>{
  const path=url.pathname;if(!path.startsWith('/api/career/'))return false;
  const relative=path.slice('/api/career'.length),method=req.method||'GET';
    const known=relative==='/bootstrap'||relative==='/profile'||relative==='/resumes'||/^\/resumes\/[^/]+(?:\/download)?$/.test(relative)||relative.startsWith('/vault/')||relative==='/credentials'||/^\/credentials\/[^/]+$/.test(relative)||relative==='/jobs'||relative==='/discover'||relative==='/sources/france-travail'||relative==='/sources/france-travail/search'||relative==='/sources/arbeitnow/search'||relative==='/applications'||/^\/applications\/[^/]+(?:\/(?:run|resume|resolve))?$/.test(relative)||relative==='/ai/config'||relative==='/ai/test'||relative==='/ai/cover-letter';
  if(!known)return false;
  try{
    if(method!=='GET'&&req.headers['x-anima-request']!=='1')throw new CareerError(403,'csrf','En-tête de requête requis.');
    const {store,vault,runner}=context;
    if(relative==='/sources/france-travail'){
      if(method==='GET'){reply(res,200,vault.franceTravailConfigSummary());return true;}
      if(method==='POST'){noDemo(context,'Configuration source France Travail');const o=await json(req);fields(o,['clientId','clientSecret','scope']);const value=vault.saveFranceTravailConfig({clientId:string(o.clientId,'Identifiant client',500),clientSecret:string(o.clientSecret,'Secret client',2000),scope:string(o.scope,'Périmètre API',500)});reply(res,200,value);return true;}
      if(method==='DELETE'){noDemo(context,'Suppression source France Travail');await json(req);vault.deleteFranceTravailConfig();reply(res,200,{deleted:true});return true;}
    }
    if(method==='POST'&&relative==='/sources/france-travail/search'){
      noDemo(context,'Recherche France Travail');if(runner.isBusy()||runner.hasPausedSession?.())throw new CareerError(409,'browser_busy','Navigateur occupé ou en attente d’une intervention.');if(!context.offerSearch)throw new CareerError(503,'source_unavailable','Recherche France Travail indisponible.');const o=await json(req);fields(o,['keywords','department','commune','contractType','limit']);const department=o.department===undefined?undefined:string(o.department,'Département',3).toUpperCase();if(department&&!/^(?:\d{2,3}|2[AB])$/.test(department))throw new CareerError(400,'validation','Le département doit être un code à 2 ou 3 chiffres, ou 2A/2B pour la Corse.');const criteria:OfferSearchCriteria={keywords:string(o.keywords,'Métier ou mot-clé',300),...(department?{department}:{}),...(o.commune!==undefined?{commune:string(o.commune,'Commune ou code INSEE',100)}:{}),...(o.contractType!==undefined?{contractType:string(o.contractType,'Type de contrat',40)}:{}),...(o.limit!==undefined?{limit:Number(o.limit)}:{})};if(o.limit!==undefined&&(!Number.isInteger(criteria.limit)||Number(criteria.limit)<1||Number(criteria.limit)>450))throw new CareerError(400,'validation','Limite de résultats invalide.');const discovered=await context.offerSearch.search(criteria);if(!Array.isArray(discovered.offers)||discovered.offers.length>450)throw new CareerError(400,'validation','Résultat de recherche invalide.');const jobs:JobOffer[]=discovered.offers.map(offer=>store.saveJob(offer));reply(res,200,{jobs,note:String(discovered.note||'').slice(0,1000)});return true;
    }
    if(method==='POST'&&relative==='/sources/arbeitnow/search'){
      noDemo(context,'Recherche Arbeitnow France');if(runner.isBusy()||runner.hasPausedSession?.())throw new CareerError(409,'browser_busy','Navigateur occupé ou en attente d’une intervention.');if(!context.publicOfferSearch)throw new CareerError(503,'source_unavailable','Recherche Arbeitnow France indisponible.');const o=await json(req);fields(o,['keywords','commune','contractType','limit']);const criteria:OfferSearchCriteria={keywords:string(o.keywords,'Métier ou mot-clé',300),...(o.commune!==undefined?{commune:string(o.commune,'Ville ou commune',100)}:{}),...(o.contractType!==undefined?{contractType:string(o.contractType,'Type de contrat',40)}:{}),...(o.limit!==undefined?{limit:Number(o.limit)}:{})};if(o.limit!==undefined&&(!Number.isInteger(criteria.limit)||Number(criteria.limit)<1||Number(criteria.limit)>450))throw new CareerError(400,'validation','Limite de résultats invalide.');const discovered=await context.publicOfferSearch.search(criteria);if(!Array.isArray(discovered.offers)||discovered.offers.length>450)throw new CareerError(400,'validation','Résultat de recherche invalide.');const jobs:JobOffer[]=discovered.offers.map(offer=>store.saveJob(offer));reply(res,200,{jobs,note:String(discovered.note||'').slice(0,1000)});return true;
    }
    if(method==='GET'&&relative==='/bootstrap'){reply(res,200,{profile:store.getProfile(),resumes:store.listResumes(),credentials:vault.listCredentials(),jobs:store.listJobs(),applications:store.listApplications(),events:store.listEvents(),metrics:store.getMetrics(),vault:vault.status()});return true;}
    if(relative.startsWith('/ai/')){
      if(context.demo)throw new CareerError(403,'demo_disabled','Fonctions IA désactivées en démonstration.');
      if(!context.ai)throw new CareerError(503,'ai_unavailable','Service IA indisponible.');
      const ai=context.ai;
      if(method==='GET'&&relative==='/ai/config'){reply(res,200,ai.config());return true;}
      if(method==='POST'&&relative==='/ai/config'){const o=await json(req);fields(o,['baseUrl','model','apiKey']);reply(res,200,{settings:ai.configure({baseUrl:string(o.baseUrl,'URL',2000),model:string(o.model,'Modèle',200),apiKey:string(o.apiKey,'Clé API',2000)})});return true;}
      if(method==='DELETE'&&relative==='/ai/config'){ai.clearConfig();reply(res,200,{deleted:true});return true;}
      if(method==='POST'&&relative==='/ai/test'){const o=await json(req);fields(o,[]);reply(res,200,await ai.testConnection());return true;}
      if(method==='POST'&&relative==='/ai/cover-letter'){const o=await json(req);fields(o,['applicationId','includeAnswers']);const includeAnswers=o.includeAnswers??false;if(typeof includeAnswers!=='boolean')throw new CareerError(400,'validation','Option de réponses invalide.');reply(res,200,await ai.draftCoverLetter(string(o.applicationId,'Candidature',64),includeAnswers));return true;}
      return false;
    }
    if(method==='PUT'&&relative==='/profile'){reply(res,200,store.saveProfile(await json(req)));return true;}
    if(method==='POST'&&relative==='/resumes'){const o=await json(req,14_500_000);fields(o,['name','filename','mime','base64']);reply(res,201,store.saveResume({name:string(o.name,'Nom',200),filename:string(o.filename,'Fichier',255),mime:string(o.mime,'Type',100),bytes:decodeResumeBase64(o.base64)}));return true;}
    const resume=relative.match(/^\/resumes\/([^/]+)(?:\/(download))?$/);if(resume){const id=resume[1];if(method==='GET'&&resume[2]==='download'){const value=store.getResume(id);res.writeHead(200,{'Content-Type':value.meta.mime,'Content-Disposition':contentDisposition(value.meta.filename),'Content-Length':value.bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(value.bytes);return true;}if(method==='DELETE'&&!resume[2]){store.deleteResume(id);reply(res,200,{deleted:true});return true;}}
    if(method==='POST'&&relative==='/vault/initialize'){noDemo(context,'Coffre');const o=await json(req);fields(o,['passphrase']);reply(res,201,vault.initialize(string(o.passphrase,'Phrase secrète',10000)));return true;}
    if(method==='POST'&&relative==='/vault/unlock'){noDemo(context,'Coffre');const o=await json(req);fields(o,['passphrase']);reply(res,200,vault.unlock(string(o.passphrase,'Phrase secrète',10000)));return true;}
    if(method==='POST'&&relative==='/vault/lock'){await json(req);await runner.stop();reply(res,200,vault.lock());return true;}
    if(method==='POST'&&relative==='/credentials'){noDemo(context,'Comptes');const o=await json(req);fields(o,['origin','label','username','password']);reply(res,201,vault.saveCredential({origin:string(o.origin,'Origine',500),label:string(o.label,'Libellé',200),username:string(o.username,'Identifiant',500),password:string(o.password,'Mot de passe',10000)}));return true;}
    const credential=relative.match(/^\/credentials\/([^/]+)$/);if(method==='DELETE'&&credential){vault.deleteCredential(credential[1]);reply(res,200,{deleted:true});return true;}
    if(method==='POST'&&relative==='/jobs'){reply(res,201,store.saveJob(await json(req)));return true;}
    if(method==='POST'&&relative==='/discover'){if(runner.isBusy()||runner.hasPausedSession?.())throw new CareerError(409,'browser_busy','Navigateur occupé ou en attente d’une intervention.');const o=await json(req);fields(o,['url']);const inputUrl=careerUrl(o.url,context.allowedTestOrigins);noDemo(context,'Découverte',inputUrl);const discovered=await context.discovery.discover(inputUrl);if(!Array.isArray(discovered.offers)||discovered.offers.length>200)throw new CareerError(400,'validation','Résultat de découverte invalide.');const jobs:JobOffer[]=discovered.offers.map(offer=>store.saveJob(offer));reply(res,200,{jobs,note:String(discovered.note||'').slice(0,1000)});return true;}
    if(method==='POST'&&relative==='/applications'){const o=await json(req);fields(o,['jobId','resumeId','prospectId']);const before=store.listApplications().some(a=>a.jobId===o.jobId);const a=store.createApplication({jobId:string(o.jobId,'Offre',64),resumeId:string(o.resumeId,'CV',64),...(o.prospectId!==undefined?{prospectId:string(o.prospectId,'Prospect',64)}:{})});reply(res,before?200:201,a);return true;}
    const application=relative.match(/^\/applications\/([^/]+)(?:\/(run|resume|resolve))?$/);if(application){const id=application[1],action=application[2];if(method==='GET'&&!action){reply(res,200,store.getApplication(id));return true;}if(method==='PATCH'&&!action){reply(res,200,store.updateApplication(id,await json(req)));return true;}if(method==='POST'&&action==='run'){const target=store.getJob(store.getApplication(id).jobId).url;noDemo(context,'Automatisation',target);const o=await json(req);fields(o,['mode','credentialId']);if(o.mode!=='prepare'&&o.mode!=='submit')throw new CareerError(400,'validation','Mode invalide.');reply(res,202,runner.start(id,o.mode,o.credentialId===undefined?undefined:string(o.credentialId,'Compte',64)));return true;}if(method==='POST'&&action==='resume'){const current=store.getApplication(id);noDemo(context,'Reprise',store.getJob(current.jobId).url);const o=await json(req);fields(o,['credentialId','fileFieldKey','resumeId']);const fileFieldKey=o.fileFieldKey===undefined?undefined:string(o.fileFieldKey,'Champ fichier',200);if(fileFieldKey&&!current.missingFields.some(field=>field.type==='file'&&field.key===fileFieldKey))throw new CareerError(400,'validation','Le champ fichier ne correspond pas à la candidature en attente.');if(!runner.resume)throw new CareerError(501,'resume_unavailable','Reprise indisponible.');reply(res,202,runner.resume(id,o.credentialId===undefined?undefined:string(o.credentialId,'Compte',64),fileFieldKey,o.resumeId===undefined?undefined:string(o.resumeId,'CV',64)));return true;}if(method==='POST'&&action==='resolve'){const o=await json(req);fields(o,['resolution','detail']);reply(res,200,store.resolveUncertain(id,{resolution:o.resolution as 'submitted'|'not_submitted',detail:string(o.detail,'Détail',1000)}));return true;}}
    return false;
  }catch(error){const e=error instanceof CareerError?error:new CareerError(500,'internal','Erreur interne de candidature.');reply(res,e.status,{error:e.message,code:e.code});return true;}
}
