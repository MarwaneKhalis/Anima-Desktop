# Anima Connect â€” architecture candidatures et prospection

Statut : spÃ©cification prÃ©alable Ã  l'implÃ©mentation, 5 octobre 2026. Responsable : architecte. Le document fixe le pÃ©rimÃ¨tre Ã  vÃ©rifier ; il ne constitue pas une preuve de fonctionnalitÃ©s dÃ©jÃ  livrÃ©es.

## 1. Audit et dÃ©cisions

Audit des fichiers rÃ©els `server/index.ts`, `server/db.ts`, `server/browser.ts`, `server/domain.ts`, `src/shared/types.ts`, `web/App.tsx`, `tests/core.test.ts`, configuration et scripts. Aucun `AGENTS.md` trouvÃ© dans le dÃ©pÃ´t.

- React 19/TypeScript/Vite ; serveur HTTP Node 24 ; SQLite synchrone avec WAL et transactions `BEGIN IMMEDIATE` ; neuf tests de domaine existants.
- `Store` possÃ¨de recherches, prospects, sources, Ã©vÃ©nements, modÃ¨les, messages et file LinkedIn. Ses Ã©vÃ©nements imposent un `prospect_id`. Ne pas les dÃ©tourner pour des candidatures.
- `LocalBrowser` ouvre Chromium persistant et visible, impose LinkedIn HTTPS, extrait les profils visibles et bloque les contrÃ´les de sÃ©curitÃ©. Il ne remplit ni n'envoie actuellement de candidature.
- `web/App.tsx` est monolithique ; ajouter un composant autonome pour le parcours carriÃ¨re et une entrÃ©e de navigation, sans rÃ©Ã©crire le CRM.
- Le serveur actuel Ã©coute sur `127.0.0.1`, vÃ©rifie certaines origines et possÃ¨de sauvegarde/restauration SQLite. L'ajout de secrets exige aussi validation Host, protection CSRF des mutations et refus des origines inattendues.

DÃ©cision : extension du dÃ©pÃ´t existant, mÃªmes serveur et base locale, tables additives `career_*`, navigateur carriÃ¨re sÃ©parÃ©, composants UI dÃ©diÃ©s. Aucun service cloud, clÃ© d'IA ou abonnement requis. ExÃ©cuter les opÃ©rations navigateur en tÃ¢che asynchrone sÃ©rialisÃ©e ; ne jamais conserver une transaction SQLite pendant un `await` Playwright.

## 2. Parcours livrÃ© et limites explicites

1. **Mon profil** : identitÃ©, coordonnÃ©es, liens, expÃ©riences, Ã©tudes, compÃ©tences, langues, prÃ©fÃ©rences et rÃ©ponses explicitement renseignÃ©es. Plusieurs CV locaux, nommÃ©s, avec choix par candidature.
2. **Offres** : rechercher sans URL dans le flux public Arbeitnow France, par mots-clÃ©s, commune et contrat ; les rÃ©sultats sont filtrÃ©s localement et dÃ©dupliquÃ©s. La recherche parcourt au plus cinq pages de 100 annonces et ne couvre donc pas tout le marchÃ©. France Travail est proposÃ© en option aux utilisateurs autorisÃ©s Ã  son API. L'import d'une URL directe, des boards Greenhouse/Lever et du JSON-LD `JobPosting` reste disponible en complÃ©ment. Chaque rÃ©sultat conserve sa source, son titre, son entreprise, son URL et sa date de collecte.
3. **Candidature** : sÃ©lectionner l'offre et le CV ; prÃ©parer automatiquement : ouvrir, se connecter si nÃ©cessaire avec le compte du domaine, remplir les champs reconnus, tÃ©lÃ©charger le CV, identifier les questions restantes.
4. **Envoyer** : un bouton explicite peut prÃ©parer puis soumettre en une action sur un formulaire pris en charge. Il autorise cette candidature et ce CV. La prÃ©paration seule ne clique jamais le bouton final. Aucun dialogue supplÃ©mentaire n'est nÃ©cessaire si les donnÃ©es et le formulaire sont connus.
5. **Suivre** : reÃ§u vÃ©rifiable, Ã©vÃ©nements, statut mÃ©tier, date de relance et notes. Ajouter entretien, rÃ©ponse, refus et offre reÃ§ue depuis la fiche ; afficher la provenance manuelle de ces mises Ã  jour.
6. **Prospection** : fonctionnalitÃ©s LinkedIn existantes accessibles depuis la mÃªme application ; liaison facultative candidature â†’ prospect ; tableau de bord commun issu des donnÃ©es stockÃ©es.

Automatisation effectivement requise : formulaires HTML standard Ã  champs Ã©tiquetÃ©s, login classique identifiant/mot de passe, fichier CV et soumission avec confirmation. Les adaptateurs livrÃ©s et testÃ©s sont nommÃ©s dans l'interface/documentation. Un adaptateur gÃ©nÃ©rique n'autorise aucune promesse de compatibilitÃ© universelle avec Workday, Taleo, LinkedIn Easy Apply ou les widgets propriÃ©taires. Les CAPTCHA, MFA, consentements lÃ©gaux inconnus, questions factuelles inconnues et boutons ambigus doivent interrompre l'action, avec une explication exploitable.

## 3. RÃ©partition des fichiers

| Responsable | Fichiers exclusifs | Livrable |
|---|---|---|
| Agent A â€” donnÃ©es et API | `src/shared/career.ts`, `server/career-store.ts`, `server/vault.ts`, `server/career-api.ts`, `tests/career-store.test.ts`, `tests/vault.test.ts` | Contrats, migrations, validation, coffre, routes et projections |
| Agent B â€” automatisation et fixtures | `server/career-browser.ts`, `server/career-runner.ts`, `tests/fixtures/careers.ts`, `tests/career-browser.test.ts` | DÃ©couverte, connexion, remplissage, upload, soumission, scÃ©narios navigateur |
| IntÃ©grateur | `server/index.ts`, `server/job-discovery.ts`, `web/CareerWorkspace.tsx`, `web/career.css`, `web/App.tsx`, scripts/package/config, tests API/UI, README | DÃ©couverte JSON-LD et boards publics, assemblage, dashboard, UX, lancement Windows, revue, vÃ©rification et publication |
| Architecte | `docs/CAREER_ARCHITECTURE.md` | Cette spÃ©cification uniquement |

L'agent A crÃ©e d'abord le fichier des contrats. Les changements de signature doivent Ãªtre communiquÃ©s avant modification. Chaque agent relit les changements de l'autre ; l'intÃ©grateur vÃ©rifie les scÃ©narios transversaux avant commit. Ne pas mÃ©langer le travail de plusieurs agents dans les mÃªmes fichiers.

## 4. Types partagÃ©s normatifs

CrÃ©er `src/shared/career.ts`. Les identifiants sont des UUID serveur, dates ISO UTC et URL absolues. Les donnÃ©es d'entrÃ©e sont validÃ©es Ã  l'exÃ©cution, mÃªme si TypeScript compile. Une chaÃ®ne vide signifie inconnu ; ne pas transformer l'inconnu en `false`.

```ts
export type ApplicationState =
  | 'draft' | 'running' | 'ready' | 'needs_input' | 'blocked'
  | 'submitting' | 'submitted' | 'uncertain' | 'failed';
export type Outcome = 'active' | 'interview' | 'offer' | 'rejected' | 'withdrawn';
export type RunMode = 'prepare' | 'submit';
export type AnswerValue = string | boolean;

export interface CareerProfile {
  firstName: string; lastName: string; email: string; phone: string;
  city: string; country: string; address: string; postalCode: string;
  headline: string; summary: string; linkedinUrl: string; websiteUrl: string;
  skills: string[]; languages: string[];
  experiences: { company: string; title: string; start: string; end: string; description: string }[];
  education: { school: string; degree: string; start: string; end: string }[];
  preferences: { titles: string[]; locations: string[]; remote: boolean; contract: string };
  // Exact normalized field/question key -> explicit user-authored fact.
  answers: Record<string, AnswerValue>;
  updatedAt: string;
}
export interface Resume {
  id: string; name: string; filename: string; mime: string; size: number;
  sha256: string; createdAt: string;
}
export interface CredentialSummary {
  id: string; origin: string; label: string; username: string; updatedAt: string;
}
export interface VaultStatus { initialized: boolean; unlocked: boolean; }
export interface JobOffer {
  id: string; url: string; title: string; company: string; location: string;
  description: string; sourceUrl: string; discoveredAt: string; updatedAt: string;
}
export interface MissingField {
  key: string; label: string; required: boolean;
  type: 'text' | 'boolean' | 'select' | 'file' | 'unknown';
  options?: string[];
}
export interface Receipt {
  url: string; text: string; reference: string; observedAt: string;
}
export interface Application {
  id: string; jobId: string; resumeId: string; prospectId: string | null;
  state: ApplicationState; outcome: Outcome;
  answers: Record<string, AnswerValue>;
  missingFields: MissingField[]; notes: string; nextActionAt: string;
  lastError: string; receipt: Receipt | null;
  createdAt: string; updatedAt: string; submittedAt: string | null;
}
export interface CareerEvent {
  id: string; applicationId: string; kind: string; detail: string;
  source: 'automation' | 'user'; happenedAt: string;
}
export interface CareerMetrics {
  savedJobs: number; applications: number; submitted: number;
  needsAttention: number; interviews: number; offers: number; rejected: number;
}
export interface CareerSnapshot {
  profile: CareerProfile; resumes: Resume[]; credentials: CredentialSummary[];
  jobs: JobOffer[]; applications: Application[]; events: CareerEvent[];
  metrics: CareerMetrics; vault: VaultStatus;
}
export interface RunResult {
  state: 'ready' | 'needs_input' | 'blocked' | 'submitted' | 'uncertain' | 'failed';
  missingFields: MissingField[]; message: string; receipt: Receipt | null;
}
export interface DiscoveryResult { jobs: JobOffer[]; note: string; }
```

`username` est une mÃ©tadonnÃ©e personnelle accessible uniquement dans l'application locale ; le mot de passe et la phrase secrÃ¨te ne figurent dans aucun type de rÃ©ponse. Les numÃ©ros d'identitÃ©, santÃ©, handicap, origine, casier judiciaire, permis de travail, salaire et clauses contractuelles n'ont jamais de valeur dÃ©duite. Ils peuvent seulement Ãªtre remplis Ã  partir d'une rÃ©ponse explicite dont la question correspond exactement.

## 5. Contrats serveur entre agents

L'agent A expose `CareerStore`, construit avec la connexion existante `new CareerStore(store.db)`. Il ne ferme pas cette connexion. Les deux instances rÃ©el/dÃ©mo utilisent chacune leur connexion. Migrer lors de construction ; aucune modification du constructeur `Store` requise.

```ts
class CareerStore {
  constructor(db: DatabaseSync);
  getProfile(): CareerProfile;
  saveProfile(input: unknown): CareerProfile;
  listResumes(): Resume[];
  saveResume(input: {name:string; filename:string; mime:string; bytes:Buffer}): Resume;
  getResume(id:string): {meta:Resume; bytes:Buffer};
  deleteResume(id:string): void; // 409 si rÃ©fÃ©rencÃ©
  saveJob(input: unknown): JobOffer; // upsert URL canonique
  listJobs(): JobOffer[];
  getJob(id:string): JobOffer;
  createApplication(input: {jobId:string; resumeId:string; prospectId?:string}): Application;
  listApplications(): Application[];
  getApplication(id:string): Application;
  updateApplication(id:string, input: unknown): Application;
  // Les seuls champs modifiables publiquement : resumeId, prospectId, answers,
  // notes, nextActionAt, outcome. Ni state ni receipt ni submittedAt.
  claimRun(id:string): Application; // atomic, reject terminal/ambiguous/active
  markSubmitting(id:string): void; // commit AVANT clic final
  finishRun(id:string, result:RunResult): Application; // Ã©tat + Ã©vÃ©nement atomiques
  recoverInterruptedRuns(): void; // running->failed; submitting->uncertain
  resolveUncertain(id:string, input:{resolution:'submitted'|'not_submitted'; detail:string}): Application;
  listEvents(): CareerEvent[];
  getMetrics(): CareerMetrics;
}
```

`createApplication` est idempotent par `jobId` pour ce profil unique : rÃ©utiliser la candidature existante ; ne jamais Ã©craser CV, rÃ©ponses ou statut lors d'un double clic. Les exceptions mÃ©tier exposent un code stable et un statut HTTP. Une candidature soumise ou incertaine ne peut Ãªtre relancÃ©e par `claimRun`. Une rÃ©solution manuelle Â« non envoyÃ©e Â» nÃ©cessite un dÃ©tail, crÃ©e un Ã©vÃ©nement, repasse en `draft` et laisse un nouvel envoi Ã  l'initiative explicite de l'utilisateur. Une rÃ©solution manuelle Â« envoyÃ©e Â» est identifiÃ©e comme dÃ©claration utilisateur, distincte d'un reÃ§u automatisÃ©.

Le coffre `Vault` de A utilise les tables de la mÃªme base. Contrat :

```ts
class Vault {
  constructor(db: DatabaseSync);
  status(): VaultStatus;
  initialize(passphrase:string): VaultStatus;
  unlock(passphrase:string): VaultStatus;
  lock(): VaultStatus;
  listCredentials(): CredentialSummary[];
  saveCredential(input:{origin:string; label:string; username:string; password:string}): CredentialSummary;
  deleteCredential(id:string): void;
  // Interne serveur uniquement. VÃ©rifie Ã©galitÃ© d'ovçM-¢G§²ÚîÆ­yØÜÜÚX›H]H™\œ›İZ[YÙHÈ[ˆ[[YH˜]˜TØÜš\™HØ\˜[]\È	ÙY™˜XÙ[Y[Hİ]\È\ÈÛÜY\Èpê[[Ú\™Kˆ[š]X[\Ø][Ûˆ[™HÙ][H›Ú\ÈÈ˜\ÙH]H[Ú[œÈLˆØ\˜Xİ0ê™\ËˆX]]˜Z\ÙH˜\ÙHˆ\œ™]\ˆ™]]™HØ[œÈ[0ê\˜][ÛˆHÛÙ™œ™K‚‹HH˜]šYØ]]\ˆØ\œšpê™H][\ÙH[ˆÛÛ^H0ê\0ê[pê™Kš\ÚX›H\ˆ0êY˜]]\İ[˜İH›Ùš[[šÙY[ˆ\œÚ\İ[ˆ\ÈÛÛÚÚY\È™\İ[[ˆpê[[Ú\™H]ÛÛİ\š[pê\È0èØH™\›Y]\™HÈ™XÛÛ›™^[Ûˆ]]ÛX]\]YH]™XÈHÛÙ™œ™H0ê]™\œ›İZ[0êH0è[™H›ØÚZ[™Hš\Ú]Kˆ™H\È0êXÜš\™HİÜ˜YÙTİ]XİH[İÈH\ÜÙH]H\Ü]YH[ˆÛZ\‹‚‹H™[œÙZYÛ™\ˆ\ÈÜ™Y[X[È[š\]Y[Y[İ\ˆ	ÛÜšYÚ[™H^XİH[œ™YÚ\İ°êYK˜[XZ\È[ˆİY™š^HHÛXZ[™KÛİ\ËYÛXZ[™Hİ\ÜğêH0ê\]Z]˜[[Yœ˜[YH0ê]˜[™ğê™HİH™Y\™Xİ[Ûˆ›Ûˆ\›İ]°êYKˆHÙ\ÜÚ[Ûˆ0êZ°èÛÛ›™Xİ0êYH]]Ù\š\ˆØ[œÈ0êXÚY™œ˜YÙK‚‹HT“Èpê]Y\ˆˆÈX›XÈÈ™Y\Ù\ˆØÚ0ê[X\È[™Ù\™]^\Ù\š[™›ËY™\ÜÙ\Èš]°êY\ËÛÛÜ˜XÚËÛ[šË[ØØ[Y™\ÜÙ\ÈTˆš]°êY\È]œ˜YÛY[ÈÛÛ[YHY[YšX[ˆÛÛœÙ\™\ˆ\È\˜[pê™\È]ZHY[YšY[°êY[[Y[[™HÙ™œ™HÈ™]\™\ˆÙ][[Y[\˜[pê™\ÈX\šÙ][™ÈÛÛ›\Ëˆ™Y\Ù\ˆÚ[™Ù[Y[	ÛÜšYÚ[™H\˜[[ˆ›^]]ÛX]\ğêH[]Iİ[™Hš\ÙH[ˆÚ\™ÙH^XÚ]H‰Ù^\İH\Ëˆ[ˆ\İËÙ][H	ÛÜšYÚ[™H^XİHHÙ\™]\ˆš^\™H\İ]]Üš\ğêYK‚‹HØ]]™YØ\™HÔS]HÛÛY[›Ùš[ĞÕˆ]ÛÙ™œ™HÚY™œ°êKˆ0àH™\İ]\˜][Ûˆˆ™Y\Ù\ˆ[ˆ[ˆXİY‹\œ°ê\ˆH˜]šYØ]]\‹™\œ›İZ[\ˆ]X˜[™Û›™\ˆ	Ø[˜ÚY[ˆÛÙ™œ™K™XÛÛœİZ\™HİÜ™XØ\™Y\”İÜ™X˜][Ø\™Y\”[›™\˜\\]Y\ˆ\ÈZYÜ˜][ÛœÈ]°êXİ\0ê\™\ˆ\È[œÈ[\œ›Û\\Ëˆ\ÈØ]]™YØ\™\È\İÜš\]Y\ÈØ[œÈX›\ÈØ\œšpê™HÚ]™[›Û˜İ[Û›™\‹ˆ™H˜[XZ\È™\İ]\™\ˆ[ˆØš™]ÛÙ™œ™H]ZHÛÛœÙ\™HHÛ0êHH	Ø[˜ÚY[›™H˜\ÙK‚‚ˆÈÈˆ[İ]\ˆH›Ü›][Z\™\È]0ê]]Â‚ÛÜœ™\ÜÛ™[˜Ù\È0ê]\›Z[š\İ\ÈšXHX™[\šXK[X™[˜[YX]]ØÛÛ\]X]\XˆŞ[›Û[Y\Èœ˜[°éØZ\ËØ[™ÛZ\È°êXÚ\Èİ\ˆ°ê[›ÛK›ÛK[XZ[0ê[0ê\Û™Kš[K›Ùš[[šÙY[ˆ]Õ‹ˆ^Û\™HÚ[\ÈØXÚ0ê\Ë0ê\ØXİ]°ê\È]Û™^\İÈÈZ\ÜÙ\ˆšY\È\È]Y\İ[ÛœÈ[˜ÛÛ›Y\ËHÛÛ\š\ÈÜ[Û›™[\Ëˆ™H˜[XZ\È™[\\ˆİ]Ú[\^H]™XÈH°ê\İ[pêH\ˆ0êY˜]]ˆ°ê\šYšY\ˆÙ[XİÛÛ™HÜ[ÛœÈ^\İ[\È]™[\\ˆÚXÚØ›ŞÜ˜Y[ÈÙ][[Y[]™XÈ˜[]\ˆ^XÚ]Kˆ]Xİ[ˆÛXÈğê[°ê\š\]YHİ\ˆH™[ZY\ˆ]Û˜İH™[ZY\ˆİX›Z]	İ[™HYÙK‚‚“Hš^\™H]Hğê[°ê\š\]YHÚ]™[\YÙ\ˆ\ÈÜ0ê\˜][ÛœÈİ[™\™ˆH\İ™HÚ]\È°ê]\ÜÚ\ˆÜ°è˜ÙH0è[™Hœ˜[˜ÚHÜ0êXÚX[H™[\\ÜØ[\˜š]˜Z\™[Y[\Èğê[Xİ]\œÈ°ê\Ù\°ê\È]H\İˆ\È°êÛ\ÈHÛÛ™š\›X][Ûˆ]]™[0ê™HÜ0êXÚYš\]Y\È0è[ˆY\]]\ˆÚHØİ[Y[0êY\ÈÈHğê[°ê\š\]YH^YÙH[™H™]]™H›ÜH
Y\ÜØYÙHH°êXÙ\[ÛˆHØ[™Y]\™H]ÛİH°êY°ê\™[˜ÙKXœÙ[˜ÙHH›Ü›][Z\™HHÛİ[Z\ÜÚ[ÛŠKˆ[™HT“Ú[™ğêYK[ˆÛXÈ°ê]\ÜÚHİHŒ™HÛÛœİ]Y[\È[™H™]]™HİY™š\Ø[K‚‚“\È›Ü›][Z\™\È[ˆ\ÚY]\œÈ0ê]\\È›Û\YHH0ê\š[pê™Hˆ›İ]ÛœÈ[\›pêYXZ\™\È^XÚ][Y[›Û[pê\È0ªÈİZ]˜[0®Ë0ªÈÛÛ[Y\ˆ0®Ë0ªÈ™^0®Ë0ªÈÛÛ[YH0®Ë\İ[™İpê\ÈH›İ]Ûˆš[˜[HØ[™Y]\™Kˆ°êZ[œÜXİ\ˆÚ[\È]ØœİXÛ\È0èÚ\]YH0ê]\HÈX^[][H^0ê]\\Ë\œ°êİ\ˆ›İXÛHİH[XšYİpëİ0êKˆ[ˆ[ÙH™\\™K\È0ê]\\È[\›pêYXZ\™\È]]™[0ê™H\˜Ûİ\Y\Èİ\ˆ0êXÛİ]œš\ˆİ]\È\È]Y\İ[ÛœËXZ\ÈH›İ]Ûˆš[˜[[Y]\™H[\™]ˆ\İ\ˆ[ˆ\˜Ûİ\œÈY[]0êH8¡¤ˆÕ‹Ü]Y\İ[ÛœÈ8¡¤ˆ°êXØ\][]Yˆ8¡¤ˆ™péİK‚‚”ğê\]Y[˜ÙHˆ˜[Y\ˆT“8¡¤ˆ0ê]Xİ\ˆØœİXÛH8¡¤ˆY[YšY\ˆ›Ü›][Z\™KÛÙÚ[ˆ8¡¤ˆ°ê\šYšY\ˆÜšYÚ[™H8¡¤ˆÛÛ›™^[ÛˆÚHÛÛ\H\ÜÛšX›H8¡¤ˆ0ê]Xİ\ˆØœİXÛH8¡¤ˆ™[\\ˆÛÛÜ™Û›°êY\ËÜ°ê\ÛœÙ\È8¡¤ˆ\ØY\ˆÕˆ8¡¤ˆ™[]™\ˆ\ÈX[œ]X[È8¡¤ˆ™[\™H›Ü›][Z\™Kİ˜[Y][Ûˆ8¡¤ˆ™XYKİHX\œ]Y]\ˆİX›Z][™Ø]˜[ÛXÈ8¡¤ˆÚ\˜Ú\ˆ™péİH8¡¤ˆİX›Z]Yİ[˜Ù\Z[‹ˆ[Z]\ˆ\È0ê]\\ËÜYÙ\È]H0ê[ZHİ[È[™HYÙH›Ûˆš\ÙH[ˆÚ\™ÙH]šY[›ØÚÙY]™XÈ˜Z\ÛÛ‹‚‚•˜[œÚ][ÛœÈ]]Üš\ğêY\È‚‚˜^™˜YÈ™XYHÈ™YY×Ú[œ]È›ØÚÙYÈ˜Z[YOˆ[›š[™Âœ[›š[™ÈOˆ™XYH™YY×Ú[œ]›ØÚÙY˜Z[Yœ[›š[™ÈOˆİX›Z][™ÈOˆİX›Z]Y[˜Ù\Z[‚œ[›š[™È[\œ›Û\H]˜[Ûİ[Z\ÜÚ[ÛˆOˆ˜Z[YœİX›Z][™È[\œ›Û\HOˆ[˜Ù\Z[‚[˜Ù\Z[ˆOˆİX›Z]Y
°ê\šYšXØ][ÛˆX[Y[JB[˜Ù\Z[ˆOˆ˜Y
°ê\šYšXØ][Ûˆ^XÚ]H›Û‹Y[›ÚJB˜‚“[ÙYšY\ˆÕ‹Ü°ê\ÛœÙ\ËÜ›Ùš[[˜[YH[™H°ê\\˜][Ûˆ°êXğêY[Kˆ]Xİ[ˆ[›ÚH™HÙHÛÛ[H	İ[ˆ[˜ÚY[ˆ™XYXÈ[[œÜXİHH›İ]™X]HHYÙH]][\ÙH[ˆÛ˜\ÚİH›Ùš[ĞÕ‹Ü°ê\ÛœÙ\È]H0êX]H[‹ˆ[\™\™H[ÙYšXØ][Û‹Üİ\™\ÜÚ[ÛˆHÛ›°êY\È	İ[™HØ[™Y]\™H[™[ÛÛˆ[‹ˆİX›Z]Y]]0ê]°ê[™[Y[[›ŞpêHÛÛÜ°êpê\È[œÈ[™HÙ][H˜[œØXİ[Ûˆ][™HÙ][H›Ú\Ëˆ\ÈÚ[™Ù[Y[ÈHİ]ÛÛYX™Hİ\š[Y[\È	Ú\İÜš\]YH	Ù[›ÚK‚‚“\È™péİ\Ëğê]°ê[™[Y[ÈİØÚÙ[[ˆ^Hœ™Y‹\ÜØZ[šKØ[œÈ›Ü›][Z\™HÛÛ\]ÙXÜ™]İHØ\\™HÙÚ[‹ˆÛÛœÙ\™\ˆH°êY°ê\™[˜ÙH]T“°êXÙ\ÜØZ\™\È0èH°ê\šYšXØ][Û‹Ø[œÈ™]ÛœÈHÙ\ÜÚ[Ûˆ[œÈ	ÕT“ˆİ\È\ÈY\ÜØYÙ\È	Ù\œ™]\ˆ^]ÜšYÚÛÛ˜YZ]ËÜØ[š]\ğê\ÈÈ™H\È[œ™YÚ\İ™\ˆ\ÈØš™]ÈH™\]pêK0ê[0ê[Y[È™[\\ÈİH˜XÙ\ÈÛÛ[˜[[ˆ\ÜİÛÜ™‚‚ˆÈÈKˆRH][™XØ]]\œÂ‚“˜]šYØ][ÛˆØ\œšpê™HÛÛ\XİHˆ
Š•X›X]HH›Ü™0­ÈÙ™œ™\È0­ÈØ[™Y]\™\È0­È[Ûˆ›Ùš[
ŠˆÈ\È›Û˜İ[ÛœÈ[šÙY[ˆ[Y]\™[XØÙ\ÜÚX›\ËˆH›Ùš[ÛÛY[\ÈÛ™Û]ËØÚ[\ÈÕˆ]ÛÛ\\Ë0ê]]™\œ›İZ[0êHš\ÚX›KXİ[Ûˆ™\œ›İZ[\‹ˆY™šXÚ\ˆ\È0êXÜ˜[œÈšY\È]™XÈ[™HXİ[Ûˆ][K\œ™]\œÈ°êÈHÚ[\0ê]]ØØİ\0êH]›ÙÜ™\ÜÚ[ÛˆH[ˆ\ˆÛ[™È[™[Xİ]š]0êK‚‚‘šXÚHÙ™œ™Hˆ]™K[™\š\ÙKY]KÛİ\˜ÙKÕˆÚÚ\ÚK›İ]ÛœÈ0ªÈ°ê\\™\ˆ0®È]0ªÈ[›ŞY\ˆXHØ[™Y]\™H0®Ëˆ[™HÛİ[Z\ÜÚ[Ûˆ^XÚ]H]]Üš\ÙHH[ˆÛÛ\]È[ˆØœİXÛH^ÜÙH^Xİ[Y[H]Y\İ[ÛˆX[œ]X[HİH	ØXİ[Ûˆ][™YKˆHšXÚHØ[™Y]\™HY™šXÚH0ê]]	Ø]]ÛX]\Ø][Ûˆ\İ[˜İH°ê\İ[]pê]Y\‹™péİHİH0êXÛ\˜][ÛˆX[Y[K0ê]°ê[™[Y[Ë™[[˜ÙH]›İ\ËˆİX›HÛXÈ]™Yœ™\Ú™HİX›[\È	Ù[›ÚK‚‚”Û]\]YH	Ø]]ÛX]\Ø][Ûˆ][\Ø]]\ˆˆHÛXÈ0ªÈ[›ŞY\ˆXHØ[™Y]\™H0®ÈÛÛœİ]YH	Ø]]Üš\Ø][ÛˆHÛÛ›™^[Û‹Ü™[\\ÜØYÙKÙ[›ÚHİ\ˆ	ÛÙ™œ™H]HÕˆš\ÚX›\Ëˆİ\ˆ[ˆİ	İ][\Ø]]\ˆğê[Xİ[Û›™H[™H\İHš[šYH	ÛÙ™œ™\È]HÕ‹Z\È[˜ÙH0ªÈ[›ŞY\ˆ\ÈˆØ[™Y]\™\È0®Ëˆ	ÕRH\[Hğê\]Y[Y[[Y[Hpê›YH[™Ú[[˜[ˆ[ÙHİX›Z]]][™Hš[ˆHÚ\]YHØ[™Y]\™HÈ[™H\œ™]\ˆ[˜Ù\Z[™HİH[ˆØœİXÛHHğêXİ\š]0êH\œ°êHHİˆ\È]Y\İ[ÛœÈX[œ]X[\ÈXÙ[HØ[™Y]\™H[œÈ\ÈXİ[ÛœÈ™\]Z\Ù\ÈØ[œÈ[™[\ˆH°ê\ÛœÙKˆHİ™HÉğê][™\È]]ÛX]\]Y[Y[0èH›İ]™[\ÈÙ™œ™\È0êXÛİ]™\\ÈÈ]Xİ[ˆ[›ÚH[ˆ\œšpê™K\[ˆ\°êÈ™\›Y]\™KÜ™XÚ\™Ù[Y[Ø[œÈ›İ]™[HXİ[Û‹ˆHš[H[š]X[HRH]ÛÛˆ0ê\š[pê™HÚ]™[™\İ\ˆš\ÚX›\Ëˆ\ÈÙXÜ™]È™HÛÛ˜[XZ\ÈÛÜpê\È[œÈÙ]Hš[KˆÙ]HÛ]\]YH]œ™H[ˆ°ê\š]X›H[ÙH	Ù[›ÚH]]ÛX]\]YH]]Üš\ğêKØ[œÈ[\ÜÙ\ˆ[™HÛÛ™š\›X][Ûˆ[™]šYY[H\°êÈÚ\]YH°ê\\˜][Ûˆ°ê]\ÜÚYK‚‚“H\Ú›Ø\™YÜ°êÙHˆÙ™œ™\ÈØ]]™YØ\™0êY\ËØ[™Y]\™\Ë[›Ú\ÈÛÛ™š\›pê\ËXİ[ÛœÈ™\]Z\Ù\Ë[™]Y[œËÙ™œ™\È™péİY\Ë™Y\ÈÈ\ÈØ\\È[šÙY[ˆ°ê]][\Ù[\È›Ú™Xİ[ÛœÈ^\İ[\ËˆİX›Z]YHØ[™Y]\™\È\İ[˜İ\È^X[[ˆİX›Z]Y]İH0ê]°ê[™[Y[HÛÛ™š\›X][Ûˆ˜[Y0êKÛÛœÙ\°êH\°êÈÚ[™Ù[Y[Hİ]]È™YYĞ][[Û˜H™YY×Ú[œ]Ø›ØÚÙYİ[˜Ù\Z[‹Ù˜Z[YÈ[™]Y[œËÛÙ™œ™\ËÜ™Y\ÈH0ê]]Èpê]Y\ˆÛİ\˜[Ë[™\]pê\ÈÛÛ[YH[ËˆXİ]š]0êH°êXÙ[HH[š[ÛˆÚ›Û›ÛÙÚ\]YH	ğê]°ê[™[Y[ÈØ[™Y]\™H]›ÜÜXİÈ]™XÈØ]0êYÛÜšYH]Y[‹ˆ]Xİ[™HÛİ\˜™HšHÚY™œ™HH0ê[[Ûœİ˜][Ûˆ[œÈH[ÙH°êY[‚‚ˆÈÈLˆ˜[Y][Ûˆ^0êXİ]X›H]˜[]œ˜Z\ÛÛ‚‚’\›™\ÜÈ›ÙN\İ
È^]ÜšYÚ^\İ[È]Xİ[™H0ê\[™[˜ÙH0è[ˆœ˜ZHÛÛ\K[™\š\ÙHİHÙ\šXÙH^\›™KˆÙ\™]\ˆš^\™Hİ\ˆ[ˆÜÛÜ˜XÚÈ[0êX]Ú\™KÛÛ^H˜]šYØ]]\ˆ\ÛÛ0êH]XY\ÜÎYXİ\ˆÒHÈ[\™]	Ø\[\ˆ\ÈÜZ[È^\›™\È[œÈ\È\İËˆ\Èš^\™\È^ÜÙ[\ÈÛÛ\]\œÈÙ\™]\ˆ]\ÈÛ›°êY\È°êY[[Y[™péİY\Ë\È[š\]Y[Y[\È\ÜÙ\[ÛœÈÓK‚‚ŸØğê[˜\š[Èš^\™Kİ\İ™]]™H^YğêYHŸKK_KK_Ÿ0êXÛİ]™\HYÙHÚ›ØœØÛÛ[˜[]^Ù™œ™\È”ÓÓ‹SÛY[œËš[™H]Ø]]™YØ\™HÈÙXÛÛ™[\Ü™HÜ°êYH]Xİ[ˆİX›ÛˆŸ°ê\\˜][Ûˆ›Ü›][Z\™Hİ[™\™”‹ÑS‹›Ùš[™[\K›ÛˆÕˆ™péİH[œÈHÛÛ°íH\ØYÈ0ê]]™XYKÛÛ\]\ˆÔÕØ[™Y]\™HHŸÛİ[Z\ÜÚ[ÛˆÔÕ™péİH^Xİ[Y[[™H›Ú\È]™XÈ[XZ[Û›ÛH]Øİ]ËÚ\ÚHÕˆğê[Xİ[Û›°êHÈ°êY°ê\™[˜ÙHš\ÚX›K0ê]]İX›Z]Y]0ê]°ê[™[Y[[š\]YHŸ\ÚY]\œÈ0ê]\\ÈY[]0êHZ\ÈÕ‹Ü]Y\İ[ÛœÈZ\È°êXØ\][]YˆÈ™\\™H]Z[H°êXØ\][]YˆØ[œÈÔÕš[˜[ÈİX›Z]\›Z[™H]™XÈ°êY°ê\™[˜ÙHŸİ]]Üš\ğêH]^Ù™œ™\Èğê[Xİ[Û›°êY\ÈÛ›™[]^™péİ\Ë]Xİ[™H›Ú\ÚpêYHÙ™œ™H[›ŞpêYHÈ[˜Ù\Z[‹ÜÙXİ\š]H›Ü]YH\ÈİZ]˜[\ÈŸÙÚ[ˆ]]ÛX]\]YHØ\X™Y\šYÙH™\œÈÛÙÚ[˜Y[YšX[Èš^\™HÚY™œ°ê\ËÛÛ›™^[ÛˆZ\È™]İ\ˆØ[™Y]\™HÈÙXÛÛ™Hš\Ú]KÜÙ\ÜÚ[Ûˆ°êX]][YšpêYH›Û˜İ[Û›™HØ[œÈØZ\ÚYH][\Ø]]\ˆŸ][KPÕˆ]^ÛÛ[\È\İ[˜İÈÈØ[™Y]\™Hˆ[›ÚYHHÕˆ‹˜[XZ\ÈH™[ZY\ˆ\ˆ0êY˜]]Ÿ]Y\İ[ÛˆX[œ]X[H\›Z\ÈH˜]˜Z[Ø›YØ]Ú\™H[˜ÛÛ›HÈ™YY×Ú[œ]]°ê\›ÈÛİ[Z\ÜÚ[ÛˆÈ°ê\ÛœÙH^XÚ]H[œ™YÚ\İ°êYHZ\È[ˆ°ê]\ÜÚHŸ]Y\İ[ÛˆÙ[œÚX›HÜ[Û›™[HÚ[\ÜšYÚ[™KÚ[™XØ\[˜ÛÛ›H™\İHšYH]‰Ù\İ\È[™[0êHŸÚÚ^ØÛÛœÙ[[Y[ÚXÚØ›ŞØ›YØ]Ú\™HØ[œÈ°ê\ÛœÙH^XÚ]H›Ü]YHÈ˜]^›ÛÛ0êY[ˆ\İ™\ÜXİ0êHÈÜ[ÛˆÙ[Xİ[™^\İ[H›Ü]YHŸĞTÒKÓQHYÙKÚYœ˜[YHHÛÛ°íHˆ›ØÚÙY]˜[™[\\ÜØYÙKÜÛİ[Z\ÜÚ[Û‹]Xİ[ˆ\\ÜÈšH°ê\0ê]][ÛˆŸ°ê\ÛœÙH[˜Ù\Z[™HÙ\™]\ˆXØÙ\HÔÕZ\È‰ØY™šXÚH]Xİ[ˆ™péİHÈ[˜Ù\Z[‹[ˆÙ][ÔÕÈ]^pêYH[ˆ™Y\ğêKHÛÛ\š\È\°êÈ™Y0ê[X\œ˜YÙHŸÛÛ˜İ\œ™[˜ÙH]^\[Èİ\Ú[][[°ê\Èˆ[ˆÙ][XØÙ\0êHÈ˜]šYØ]]\‹Ù0êXÛİ]™\H™H0ê]İ\›™[\ÈHYÙH[ˆÛİ\œÈŸÜšYÚ[™HÜİ[H™Y\™Xİ[ÛˆÙÚ[ˆ™\œÈ]]™HÜšYÚ[™KÚYœ˜[YH0ê]˜[™ğê™Hˆ]Xİ[ˆ[İH\ÜÙH™[\KÙ[›ŞpêHÈT“š]°êYH]ÜİÓÜšYÚ[ˆ[˜ÛÜœ™XİÈ™Z™]0ê\ÈŸÛÙ™œ™HX]]˜Z\ÙH˜\ÙH]Ú\\^İYÈ[0ê\°êH™Y\ğê\ÈÈØÚÈ[\™]0êXÚY™œ˜YÙHÈ˜\ÙH]”ÓÓ‹ÛÙÜÈ™HÛÛY[›™[šH\ÜİÛÜ™šH\ÜÜ˜\ÙHŸ™\š\ÙKÜ™\İ]\˜][Ûˆ[œ™YÚ\İ™[Y[İX›Z][™ÈZ\È›İ]™X]HİÜ™HÛ›™H[˜Ù\Z[ˆÈØ]]™YØ\™KÜ™\İ]\˜][ÛˆÛÛœÙ\™HÕˆ]\İÜš\]YHÈ[˜ÚY[ˆÛÙ™œ™H™\İH[][\ØX›H\°êÈ™\İ]\˜][ÛˆŸ°êYÜ™\ÜÚ[ÛˆÔ“H™]Yˆ\İÈ\İÜš\]Y\È\ÜÙ[™XÚ\˜Ú\ËÚ[\ÜÙ0êYİX›Û›˜YÙH]š[H[šÙY[ˆ™\İ[Ü0ê\˜][Û›™[ÈŸRH°êY[HšXH˜]šYØ]]\ˆØØ[ˆÜ°êY\ˆ›Ùš[\ØY\ˆ]^Õ‹Ø]]™YØ\™\ˆÛÛ\Hš^\™K0êXÛİ]œš\ˆÙ™œ™K°ê\\™\‹Ù[›ŞY\‹›Ú\ˆ™péİKÙ\Ú›Ø\™Z\È™[ØYÈ[œÜXİ\ˆÛÛœÛÛH]\œ™]\œÈ°ê\ÙX]H‚ÛÛ[X[™\ÈH]œ˜Z\ÛÛˆˆœH\İœHZ[Z\È\İ˜]šYØ]]\ˆ[0êYÜ°êH°êY[[Y[^0êXİ]0êH]™XÈÚ›ÛZ][Kˆ\È\İÈ]]™[][\Ù\ˆ	Ù^0êXİ]X›H›ÙHXœÛÛHÚHœH\İXœÙ[XZ\ÈÛÛœÚYÛ™\ˆHÛÛ[X[™H^XİKˆÚHH˜]šYØ]]\ˆX[œ]YK[œİ[\ˆH[[YH^]ÜšYÚÙ[Ûˆ	Ø]]Üš\Ø][ÛˆH	İ][\Ø]]\ˆÈ™H˜[XZ\ÈÛÛ™\\ˆ[ˆ\İ˜]šYØ]]\ˆ™\]Z\È[ˆ\İYÛ›Ü°êH][››Û˜Ù\ˆH°ê]\ÜÚ]K‚‚“\ÈÛÜY\ÈH\İÈÚ]™[\İ[™İY\ˆ\ÈØğê[˜\š[ÜÈ^0êXİ]0ê\Ë\È[Z]\ÈÛÛ›Y\È]İ]HÛİ]™\\™HXœÙ[Kˆ	ØXœÙ[˜ÙH	Ù\œ™]\ˆ\TØÜš\™H™[\XÙH\È	Ù\ÜØZHH›İ][ˆ›İ]‚‚ˆÈÈLKˆ™]YH]X›XØ][Û‚‚]˜[ÛÛ[Z]ˆ™]YHÜ›Ú\ğêYHİ\ˆ˜[Y][ÛœÈ	Ù[°êYK[š™Xİ[ÛˆÓKÜšYÚ[™KÙXÜ™]Ë0ê]]\˜X›H]˜[ÛXÈ]XœÙ[˜ÙHHİX›HÛİ[Z\ÜÚ[ÛˆÈÛÜœ™Xİ[ÛˆHİ\È›Ø›0êY\È›Ü]X[Ëˆ[œÜXİ[ÛˆHY™ˆ]šXÚY\œÈİYÙYİ\ˆ^Û\™H]KØÕˆ°êY[ËÜ™Y[X[ËØ\\™\ÈİHÙÜÈš]°ê\Ëˆ™H\È0êXÜ˜\Ù\ˆ\ÈšXÚY\œÈ0êZ°èİYÙYH	İ][\Ø]]\ˆÈÛÛœÙ\™\ˆ	Ú\İÜš\]YKØœ˜[˜ÚH^\İ[È]˜[Ú[™Ù[Y[ÈHœ˜[˜ÚKˆX›Y\ˆ[œÈH0ê\0í[š[XKPÛÛ›™Xİ^\İ[Ù[ÛˆHX[™]][\Ø]]\ˆÈ]XÚ\ˆİ]HˆÜ°êpêYH]HÚ]ˆ]œ˜Z\ÛÛˆXØÛÛ\YÛ°êYHHHÛÛ[X[™HÚ[™İÜÈH0ê[X\œ˜YÙKT“ØØ[Kš[[ˆ\È\İÈ]0ê\š[pê™H^Xİ\È›Ü›][Z\™\Èš\È[ˆÚ\™ÙK‚