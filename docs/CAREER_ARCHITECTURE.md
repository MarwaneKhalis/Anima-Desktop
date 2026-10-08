# Anima Connect — architecture candidatures et prospection

Statut : architecture et limites du parcours bureau, mise à jour le 8 octobre 2026. Les décisions des sections suivantes décrivent la cible initiale ; la section 2 résume les sources et adaptateurs effectivement présents dans le code.

## 1. Audit et décisions

Audit des fichiers réels `server/index.ts`, `server/db.ts`, `server/browser.ts`, `server/domain.ts`, `src/shared/types.ts`, `web/App.tsx`, `tests/core.test.ts`, configuration et scripts. Aucun `AGENTS.md` trouvé dans le dépôt.

- React 19/TypeScript/Vite ; serveur HTTP Node 24 ; SQLite synchrone avec WAL et transactions `BEGIN IMMEDIATE` ; neuf tests de domaine existants.
- `Store` possède recherches, prospects, sources, événements, modèles, messages et file LinkedIn. Ses événements imposent un `prospect_id`. Ne pas les détourner pour des candidatures.
- `LocalBrowser` ouvre Chromium persistant et visible, impose LinkedIn HTTPS, extrait les profils visibles et bloque les contrôles de sécurité. Il ne remplit ni n'envoie actuellement de candidature.
- `web/App.tsx` est monolithique ; ajouter un composant autonome pour le parcours carrière et une entrée de navigation, sans réécrire le CRM.
- Le serveur actuel écoute sur `127.0.0.1`, vérifie certaines origines et possède sauvegarde/restauration SQLite. L'ajout de secrets exige aussi validation Host, protection CSRF des mutations et refus des origines inattendues.

Décision : extension du dépôt existant, mêmes serveur et base locale, tables additives `career_*`, navigateur carrière séparé, composants UI dédiés. Aucun service cloud, clé d'IA ou abonnement requis. Exécuter les opérations navigateur en tâche asynchrone sérialisée ; ne jamais conserver une transaction SQLite pendant un `await` Playwright.

## 2. Parcours livré et limites explicites

1. **Mon profil** : identité, coordonnées, liens, expériences, études, compétences, langues, préférences et réponses explicitement renseignées. Plusieurs CV locaux, nommés, avec choix par candidature.
2. **Offres** : rechercher sans URL dans les flux publics Arbeitnow France, Jobicy, Remote OK et Himalayas, par mots-clés et filtres compatibles ; les résultats sont filtrés et dédupliqués. Arbeitnow parcourt au plus cinq pages de 100 annonces et renvoie au plus 450 offres ; Jobicy et Remote OK conservent au plus 200 résultats chacun ; Himalayas utilise une page de 20 résultats et respecte son actualisation quotidienne. Les flux distants gardent les annonces accessibles depuis la France. Ces sources ne couvrent pas tout le marché. France Travail reste une option avec identifiants API habilités. L'import d'une URL directe, des boards Greenhouse/Lever et du JSON-LD `JobPosting` reste disponible en complément. Chaque résultat conserve sa source, son titre, son entreprise, son URL et sa date de collecte.
3. **Candidature** : sélectionner l'offre et le CV ; préparer automatiquement : ouvrir, se connecter si nécessaire avec le compte du domaine, remplir les champs reconnus, télécharger le CV, identifier les questions restantes.
4. **Envoyer** : un bouton explicite peut préparer puis soumettre en une action sur un formulaire pris en charge. Il autorise cette candidature et ce CV. La préparation seule ne clique jamais le bouton final. Aucun dialogue supplémentaire n'est nécessaire si les données et le formulaire sont connus.
5. **Suivre** : reçu vérifiable, événements, statut métier, date de relance et notes. Ajouter entretien, réponse, refus et offre reçue depuis la fiche ; afficher la provenance manuelle de ces mises à jour.
6. **Prospection** : fonctionnalités LinkedIn existantes accessibles depuis la même application ; liaison facultative candidature → prospect ; tableau de bord commun issu des données stockées.

Automatisation effectivement requise : formulaires HTML standard à champs étiquetés, login classique identifiant/mot de passe, fichier CV et soumission avec confirmation. Les adaptateurs présents sont Greenhouse, Lever, Ashby, Recruitee, Workable, SmartRecruiters, Teamtailor et Workday, sur leurs hôtes publics explicitement autorisés. Aucun adaptateur générique ne promet une compatibilité universelle avec Taleo, LinkedIn Easy Apply ou les widgets propriétaires. Les CAPTCHA, MFA, consentements légaux inconnus, questions factuelles inconnues et boutons ambigus interrompent l'action, avec une explication exploitable.

## 3. Répartition des fichiers

| Responsable | Fichiers exclusifs | Livrable |
|---|---|---|
| Agent A — données et API | `src/shared/career.ts`, `server/career-store.ts`, `server/vault.ts`, `server/career-api.ts`, `tests/career-store.test.ts`, `tests/vault.test.ts` | Contrats, migrations, validation, coffre, routes et projections |
| Agent B — automatisation et fixtures | `server/career-browser.ts`, `server/career-runner.ts`, `tests/fixtures/careers.ts`, `tests/career-browser.test.ts` | Découverte, connexion, remplissage, upload, soumission, scénarios navigateur |
| Intégrateur | `server/index.ts`, `server/job-discovery.ts`, `web/CareerWorkspace.tsx`, `web/career.css`, `web/App.tsx`, scripts/package/config, tests API/UI, README | Découverte JSON-LD et boards publics, assemblage, dashboard, UX, lancement Windows, revue, vérification et publication |
| Architecte | `docs/CAREER_ARCHITECTURE.md` | Cette spécification uniquement |

L'agent A crée d'abord le fichier des contrats. Les changements de signature doivent être communiqués avant modification. Chaque agent relit les changements de l'autre ; l'intégrateur vérifie les scénarios transversaux avant commit. Ne pas mélanger le travail de plusieurs agents dans les mêmes fichiers.

## 4. Types partagés normatifs

Créer `src/shared/career.ts`. Les identifiants sont des UUID serveur, dates ISO UTC et URL absolues. Les données d'entrée sont validées à l'exécution, même si TypeScript compile. Une chaîne vide signifie inconnu ; ne pas transformer l'inconnu en `false`.

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

`username` est une métadonnée personnelle accessible uniquement dans l'application locale ; le mot de passe et la phrase secrète ne figurent dans aucun type de réponse. Les numéros d'identité, santé, handicap, origine, casier judiciaire, permis de travail, salaire et clauses contractuelles n'ont jamais de valeur déduite. Ils peuvent seulement être remplis à partir d'une réponse explicite dont la question correspond exactement.

## 5. Contrats serveur entre agents

L'agent A expose `CareerStore`, construit avec la connexion existante `new CareerStore(store.db)`. Il ne ferme pas cette connexion. Les deux instances réel/démo utilisent chacune leur connexion. Migrer lors de construction ; aucune modification du constructeur `Store` requise.

```ts
class CareerStore {
  constructor(db: DatabaseSync);
  getProfile(): CareerProfile;
  saveProfile(input: unknown): CareerProfile;
  listResumes(): Resume[];
  saveResume(input: {name:string; filename:string; mime:string; bytes:Buffer}): Resume;
  getResume(id:string): {meta:Resume; bytes:Buffer};
  deleteResume(id:string): void; // 409 si référencé
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
  finishRun(id:string, result:RunResult): Application; // état + événement atomiques
  recoverInterruptedRuns(): void; // running->failed; submitting->uncertain
  resolveUncertain(id:string, input:{resolution:'submitted'|'not_submitted'; detail:string}): Application;
  listEvents(): CareerEvent[];
  getMetrics(): CareerMetrics;
}
```

`createApplication` est idempotent par `jobId` pour ce profil unique : réutiliser la candidature existante ; ne jamais écraser CV, réponses ou statut lors d'un double clic. Les exceptions métier exposent un code stable et un statut HTTP. Une candidature soumise ou incertaine ne peut être relancée par `claimRun`. Une résolution manuelle « non envoyée » nécessite un détail, crée un événement, repasse en `draft` et laisse un nouvel envoi à l'initiative explicite de l'utilisateur. Une résolution manuelle « envoyée » est identifiée comme déclaration utilisateur, distincte d'un reçu automatisé.

Le coffre `Vault` de A utilise les tables de la même base. Contrat :

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
  // Interne serveur uniquement. Vérifie égalité d'origine après normalisation.
  getCredential(id:string, origin:string): {username:string; password:string};
}
```

Le moteur B expose :

```ts
interface CareerBrowserOptions { headless?:boolean; allowedTestOrigins?:string[]; }
class CareerBrowser {
  constructor(options?:CareerBrowserOptions);
  discover(url:string): Promise<{offers:Omit<JobOffer,'id'|'discoveredAt'|'updatedAt'>[]; note:string}>;
  run(input:{
    application:Application; job:JobOffer; profile:CareerProfile;
    resume:{meta:Resume; bytes:Buffer}; mode:RunMode;
    // Ne demander le secret qu'après identification de l'origine du formulaire login.
    getCredential:(origin:string)=>{username:string; password:string}|null;
    beforeSubmit:()=>void;
    // Verrouillage/annulation invalide ce contexte ; ne pas soumettre après cela.
    signal?:AbortSignal;
  }): Promise<RunResult>;
  close(): Promise<void>;
}
class CareerRunner {
  constructor(store:CareerStore, vault:Vault, browser:CareerBrowser);
  start(id:string, mode:RunMode, credentialId?:string): Application;
  isBusy(): boolean;
  stop(): Promise<void>;
}
```

`start` rejette immédiatement si un autre run/découverte utilise le contexte ; claim puis lance une promesse suivie d'un `catch` qui persiste un résultat sûr. Son résultat HTTP est l'application `running`, jamais un succès simulé. `beforeSubmit` appelle `markSubmitting`; un échec postérieur devient `uncertain`. Le navigateur relit tous les champs et obstacles avant le clic final. `stop` annule et ferme le contexte ; la conséquence d'une interruption dépend de la présence du marqueur durable `submitting`.

La découverte navigateur et les runs partagent un verrou explicite. Ne pas permettre à une découverte de changer la page d'un run en cours. Une deuxième action concurrente renvoie 409. Variante acceptable : contextes distincts pour découverte et candidature, tout en sérialisant les candidatures.

Contrat complémentaire de découverte, propriété de l'intégrateur :

```ts
interface CareerDiscovery {
  discover(url:string): Promise<{
    offers:Omit<JobOffer,'id'|'discoveredAt'|'updatedAt'>[];
    note:string;
  }>;
}
```

`server/job-discovery.ts` implémente les sources publiques Greenhouse et Lever à partir d'une URL de board reconnue, plus JSON-LD `JobPosting` depuis une URL publique générique. Le client saisit une URL ; il ne fournit jamais une URL de proxy HTTP arbitraire. Le service valide les destinations et redirections, limite taille/temps/pagination, et conserve l'URL finale de candidature. Aucun besoin d'authentification pour ces adaptateurs publics. `server/arbeitnow-france-discovery.ts` ajoute une recherche sans URL depuis l'API publique Arbeitnow France : cinq pages maximum, 100 entrées par page, filtres locaux, cache de dix minutes et limite de 450 offres renvoyées. `server/jobicy-remote-discovery.ts` ajoute le flux public des emplois distants Jobicy, plafonné à 200 offres et mis en cache une heure. `server/remoteok-discovery.ts` ajoute le flux public Remote OK, avec le même plafond et cache horaire. `server/himalayas-discovery.ts` utilise l'API publique Himalayas, conserve son lien d'attribution, n'accepte que les annonces France ou monde entier, renvoie au plus une page de 20 résultats et met les réponses en cache 24 heures selon l'actualisation annoncée par la source. Ces services sont conservés pendant toute la durée du processus pour que leurs caches restent actifs entre recherches. `server/public-offer-aggregator.ts` les interroge en parallèle, poursuit en cas d'échec partiel, équilibre les résultats, déduplique les URL de candidature ou de fiche et plafonne la liste combinée à 200. `FranceTravailDiscovery` reste une source séparée qui demande des identifiants habilités. L'API persiste les offres via `CareerStore.saveJob` puis renvoie les résultats. Les fixtures couvrent les chemins déterministes ; les contrôles en direct restent en lecture seule.

`server/remoteok-discovery.ts` ajoute le flux JSON public Remote OK, conserve le lien canonique pour l’attribution, filtre les annonces de plus de 60 jours et n’inclut que les zones explicitement compatibles avec la France ; sa réponse est plafonnée à 200 offres et mise en cache une heure. Sur une fiche Remote OK, le navigateur pré-vérifie le redirecteur Apply `/l/{id}` et ne permet la suite que vers un ATS connu.

L’API publique Himalayas alimente aussi la recherche distante (20 résultats par page, cache local de 24 heures). La fiche Himalayas reste le lien d’attribution ; si elle ne contient pas de champs de candidature et propose un unique lien Apply visible vers un ATS reconnu, le navigateur peut poursuivre vers cet ATS. Les formulaires Himalayas ou les destinations non reconnues demandent une reprise manuelle.

## 6. API HTTP exacte

Préfixe `/api/career`. Toutes les réponses JSON ont `Cache-Control: no-store`. Erreurs : `{error:string, code:string}` ; 400 validation, 403 origine, 404 absence, 409 conflit, 423 coffre verrouillé, 413 taille excessive. Les routes nouvelles sont déléguées par `index.ts` à `handleCareerApi(req,res,url,context): Promise<boolean>` ; `false` signifie route inconnue. Contexte A : `{store:CareerStore,vault:Vault,browser:CareerBrowser,runner:CareerRunner,discovery:CareerDiscovery,demo:boolean}`. L'interface structurelle `CareerDiscovery` est exportée depuis `src/shared/career.ts`, sans dépendance serveur. Les helpers JSON/réponse sont privés au module ou fournis par root sans dépendance circulaire.

| Méthode et chemin relatif | Entrée | Réponse |
|---|---|---|
| GET `/bootstrap` | — | 200 `CareerSnapshot` |
| PUT `/profile` | `CareerProfile` sans `updatedAt` | 200 `CareerProfile` |
| POST `/resumes` | JSON `{name,filename,mime,base64}` | 201 `Resume` |
| GET `/resumes/:id/download` | — | Binaire, Content-Disposition attachment |
| DELETE `/resumes/:id` | — | 200 `{deleted:true}` |
| POST `/vault/initialize` | `{passphrase}` | 201 `VaultStatus` |
| POST `/vault/unlock` | `{passphrase}` | 200 `VaultStatus` |
| POST `/vault/lock` | `{}` | 200 `VaultStatus`, stop navigateur avant réponse |
| POST `/credentials` | `{origin,label,username,password}` | 201 `CredentialSummary` |
| DELETE `/credentials/:id` | — | 200 `{deleted:true}` |
| POST `/jobs` | `{url,title,company,location,description?,sourceUrl?}` | 201 `JobOffer` |
| POST `/discover` | `{url}` | 200 `DiscoveryResult`, offres persistées |
| POST `/sources/all-public/search` | `{keywords,commune?,contractType?,limit?}` ; quatre sources publiques, 200 offres max | 200 `{jobs,note}`, offres persistées et dédupliquées |
| POST `/sources/{france-travail,arbeitnow,jobicy,remoteok,himalayas}/search` | mots-clés et filtres propres à la source | 200 `{jobs,note}`, offres persistées |
| POST `/applications` | `{jobId,resumeId,prospectId?}` | 201 `Application` (200 si existante) |
| GET `/applications/:id` | — | 200 `Application` |
| PATCH `/applications/:id` | réponses/champs publics ci-dessus | 200 `Application` |
| POST `/applications/:id/run` | `{mode:'prepare'|'submit',credentialId?}` | 202 `Application` |
| POST `/applications/:id/resolve` | `{resolution:'submitted'|'not_submitted',detail}` | 200 `Application` |

La démo utilise de fausses données isolées et refuse découverte/navigation/envoi/stockage de secrets réels. Le frontend ne doit jamais transmettre un secret en query string, journaliser une requête, conserver un secret dans localStorage ou garder le mot de passe après succès.

Protection locale : API liée exclusivement à loopback ; Host limité aux noms et ports locaux configurés ; Origin comparée exactement ; refuser `Sec-Fetch-Site: cross-site`. Les mutations carrière exigent `X-Anima-Request: 1`, et JSON sauf téléchargement ; le navigateur malveillant externe ne peut envoyer ce header sans préflight accepté. Ne pas activer CORS général. Les requêtes API serveur de test sans Origin exigent aussi ce header. Ajouter ce header au helper UI carrière. Vérifier la sécurité avant l'analyse du corps. La liste des origines de test est une option constructeur contrôlée par le harness, jamais une propriété JSON client ni un mode démo.

## 7. Stockage, coffre et restauration

- Tables : `career_profile` singleton JSON, `career_resumes` métadonnées et BLOB, `career_jobs` URL UNIQUE, `career_applications` job_id UNIQUE/FK, `career_events` FK/index, `career_vault` version/sel/vérificateur, `career_credentials` id/origin/label/username/ciphertext/nonce/tag. Les JSON sont des valeurs, jamais SQL interpolé.
- CV PDF/DOCX seulement, 10 MiB décodés maximum, cohérence extension/MIME/signature ; nom de téléchargement assaini, aucune utilisation du filename fourni comme chemin. Les octets SQLite assurent sauvegarde complète et upload Playwright `{name,mimeType,buffer}` sans fichier temporaire supplémentaire. Le plafond JSON de cette route couvre le base64 et refuse l'excès avant accumulation illimitée.
- Coffre : dérivation `scrypt` avec sel aléatoire de 16 octets, `N=32768,r=8,p=1,maxmem>=64MiB`, clé 32 octets ; AES-256-GCM, nonce aléatoire 12 octets par écriture, tag 16 octets, données authentifiées comprenant version/id/origin. Chiffrer un vérificateur connu indépendant pour vérifier la phrase même si aucun compte n'existe.
- Au repos aucun mot de passe, phrase secrète ni clé dans la base, fichier de configuration, logs ou frontend persistant. La clé reste en mémoire serveur et est écrasée autant que possible au verrouillage ; un runtime JavaScript ne garantit pas l'effacement de toutes les copies mémoire. Initialisation une seule fois ; phrase au moins 12 caractères. Mauvaise phrase : erreur neutre sans altération du coffre.
- Le navigateur carrière utilise un contexte éphémère, visible par défaut, distinct du profil LinkedIn persistant. Les cookies restent en mémoire et sont supprimés à sa fermeture ; reconnexion automatique avec le coffre déverrouillé à une prochaine visite. Ne pas écrire `storageState` ou mots de passe au disque en clair.
- Renseigner les credentials uniquement sur l'origine exacte enregistrée, jamais un suffixe de domaine, sous-domaine supposé équivalent, iframe étrangère ou redirection non approuvée. La session déjà connectée peut servir sans déchiffrage.
- URLs métier : HTTPS public ; refuser schémas dangereux, userinfo, adresses privées/loopback/link-local, adresses IPv6 privées et fragments comme identifiant. Conserver les paramètres qui identifient réellement une offre ; retirer seulement paramètres marketing connus. Refuser changement d'origine durant un flux automatisé tant qu'une prise en charge explicite n'existe pas. En tests, seule l'origine exacte du serveur fixture est autorisée.
- Sauvegarde SQLite contient profil/CV et coffre chiffré. À la restauration : refuser un run actif, arrêter le navigateur, verrouiller et abandonner l'ancien coffre, reconstruire `Store`, `CareerStore`, `Vault`, `CareerRunner`, appliquer les migrations et récupérer les runs interrompus. Les sauvegardes historiques sans tables carrière doivent fonctionner. Ne jamais restaurer un objet coffre qui conserve la clé de l'ancienne base.

## 8. Moteur de formulaires et états

Correspondances déterministes via `label`, `aria-label`, `name`, `autocomplete` et `type`. Synonymes français/anglais précis pour les coordonnées ; les champs clairement identifiés d’expérience et de formation reprennent, dans l’ordre du formulaire, les entrées correspondantes du profil. Une réponse propre à la candidature garde la priorité. Exclure champs cachés, désactivés et honeypots ; laisser vides les questions inconnues, y compris optionnelles. Ne jamais remplir tout champ texte avec le résumé par défaut ou inventer une donnée absente. Vérifier `select` contre options existantes et remplir checkbox/radio seulement avec valeur explicite. Aucun clic générique sur le premier `button` ou premier `submit` d'une page.

La fixture et le générique doivent partager les opérations standard. Le test ne doit pas réussir grâce à une branche spéciale remplissant arbitrairement des sélecteurs réservés au test. Les règles de confirmation peuvent être spécifiques à un adaptateur si documentées ; le générique exige une preuve forte (message de réception de candidature et/ou référence, absence du formulaire de soumission). Une URL changée, un clic réussi ou HTTP 200 ne constituent pas une preuve suffisante.

Les formulaires en plusieurs étapes font partie du périmètre : boutons intermédiaires explicitement nommés « Suivant », « Continuer », « Next », « Continue », distingués du bouton final de candidature. Réinspecter champs et obstacles à chaque étape ; maximum dix étapes, arrêt sur boucle ou ambiguïté. En mode prepare, les étapes intermédiaires peuvent être parcourues pour découvrir toutes les questions, mais le bouton final demeure interdit. Tester un parcours identité → CV/questions → récapitulatif → reçu.

Séquence : valider URL → détecter obstacle → identifier formulaire/login → vérifier origine → connexion si compte disponible → détecter obstacle → remplir coordonnées/réponses → uploader CV → relever les manquants → relire formulaire/validation → ready, ou marqueur `submitting` avant clic → chercher reçu → submitted/uncertain. Limiter les étapes/pages et le délai total ; une page non prise en charge devient `blocked` avec raison.

Transitions autorisées :

```text
draft / ready / needs_input / blocked / failed -> running
running -> ready | needs_input | blocked | failed
running -> submitting -> submitted | uncertain
running interrompu avant soumission -> failed
submitting interrompu -> uncertain
uncertain -> submitted (vérification manuelle)
uncertain -> draft (vérification explicite non-envoi)
```

Modifier CV/réponses/profil invalide une préparation précédente. Aucun envoi ne se contente d'un ancien `ready` ; il inspecte de nouveau la page et utilise un snapshot du profil/CV/réponses au début du run. Interdire modification/suppression de données d'une candidature pendant son run. `submittedAt` et événement envoyé sont créés dans une seule transaction et une seule fois. Les changements de `outcome` ne suppriment pas l'historique d'envoi.

Les reçus/événements stockent un texte bref, assaini, sans formulaire complet, secret ou capture login. Conserver la référence et URL nécessaires à la vérification, sans jetons de session dans l'URL. Tous les messages d'erreur Playwright sont traduits/sanitisés ; ne pas enregistrer les objets de requête, éléments remplis ou traces contenant un password.

## 9. UI et indicateurs

Navigation carrière compacte : **Tableau de bord · Offres · Candidatures · Mon profil** ; les fonctions LinkedIn demeurent accessibles. Le profil contient les onglets/champs CV et comptes, état verrouillé visible, action verrouiller. Afficher des écrans vides avec une action utile, erreurs près du champ, état occupé et progression du run par polling pendant activité.

Fiche offre : titre, entreprise, lieu, source, CV choisi, boutons « Préparer » et « Envoyer ma candidature ». Une soumission explicite autorise le run complet ; un obstacle expose exactement la question manquante ou l'action attendue. La fiche candidature affiche état d'automatisation distinct du résultat métier, reçu ou déclaration manuelle, événements, relance et notes. Double clic et refresh ne doublent pas l'envoi.

Politique d'automatisation utilisateur : le clic « Envoyer ma candidature » constitue l'autorisation de connexion/remplissage/envoi pour l'offre et le CV visibles. Pour un lot, l'utilisateur sélectionne une liste finie d'offres et le CV, puis lance « Envoyer les N candidatures ». L'UI appelle séquentiellement le même endpoint `run` en mode submit et attend la fin de chaque candidature ; une erreur incertaine ou un obstacle de sécurité arrête le lot. Les questions manquantes placent la candidature dans les actions requises sans inventer de réponse. Le lot ne s'étend pas automatiquement à de nouvelles offres découvertes ; aucun envoi en arrière-plan après fermeture/rechargement sans nouvelle action. La file initiale UI et son périmètre doivent rester visibles. Les secrets ne sont jamais copiés dans cette file. Cette politique livre un véritable mode d'envoi automatique autorisé, sans imposer une confirmation individuelle après chaque préparation réussie.

Le dashboard agrège : offres sauvegardées, candidatures, envois confirmés, actions requises, entretiens, offres reçues, refus ; les cartes LinkedIn réutilisent les projections existantes. `submitted` = candidatures distinctes ayant un `submittedAt` ou événement de confirmation validé, conservé après changement de statut ; `needsAttention` = needs_input/blocked/uncertain/failed ; entretiens/offres/refus = états métier courants, indiqués comme tels. Activité récente = union chronologique d'événements candidature et prospects avec catégorie et lien. Aucune courbe ni chiffre de démonstration dans le mode réel.

## 10. Validation exécutable avant livraison

Harness `node:test` + Playwright existant ; aucune dépendance à un vrai compte, entreprise ou service externe. Serveur fixture sur un port loopback aléatoire, contexte navigateur isolé et `headless:true` pour CI ; interdit d'appeler des portails externes dans les tests. Les fixtures exposent des compteurs serveur et les données réellement reçues, pas uniquement des assertions DOM.

| Scénario fixture/test | Preuve exigée |
|---|---|
| Découverte | Page `/jobs` contenant deux offres JSON-LD/liens, filtre et sauvegarde ; second import ne crée aucun doublon |
| Préparation | Formulaire standard FR/EN, profil rempli, bon CV reçu dans le contrôle upload ; état ready, compteur POST candidature = 0 |
| Soumission | POST reçu exactement une fois avec email/nom et octets/hash du CV sélectionné ; référence visible, état submitted et événement unique |
| Plusieurs étapes | Identité puis CV/questions puis récapitulatif ; prepare atteint le récapitulatif sans POST final ; submit termine avec référence |
| Lot autorisé | Deux offres sélectionnées donnent deux reçus, aucune troisième offre envoyée ; uncertain/security bloque les suivantes |
| Login automatique | `/apply` redirige vers `/login`, identifiants fixture chiffrés, connexion puis retour candidature ; seconde visite/session réauthentifiée fonctionne sans saisie utilisateur |
| Multi-CV | Deux contenus distincts ; candidature B envoie le CV B, jamais le premier par défaut |
| Question manquante | Permis de travail obligatoire inconnu ; needs_input et zéro soumission ; réponse explicite enregistrée puis run réussi |
| Question sensible optionnelle | Champ origine/handicap inconnu reste vide et n'est pas inventé |
| Choix/consentement | Checkbox obligatoire sans réponse explicite bloque ; faux booléen est respecté ; option select inexistante bloque |
| CAPTCHA/MFA | Page/iframe de contrôle : blocked avant remplissage/soumission, aucun bypass ni répétition |
| Réponse incertaine | Serveur accepte POST puis n'affiche aucun reçu ; uncertain, un seul POST ; deuxième run refusé, y compris après redémarrage |
| Concurrence | Deux appels start simultanés : un seul accepté ; navigateur/découverte ne détournent pas la page en cours |
| Origine hostile | Redirection login vers autre origine/iframe étrangère : aucun mot de passe rempli/envoyé ; URL privée et Host/Origin incorrects rejetés |
| Coffre | Mauvaise phrase et ciphertext/tag altéré refusés ; lock interdit déchiffrage ; base et JSON/logs ne contiennent ni password ni passphrase |
| Reprise/restauration | Enregistrement submitting puis nouveau Store donne uncertain ; sauvegarde/restauration conserve CV et historique ; ancien coffre reste inutilisable après restauration |
| Régression CRM | Neuf tests historiques passent, recherches/import/dédoublonnage et file LinkedIn restent opérationnels |
| UI réelle | Via navigateur local : créer profil, uploader deux CV, sauvegarder compte fixture, découvrir offre, préparer/envoyer, voir reçu/dashboard puis reload ; inspecter console et erreurs réseau |

Commandes de livraison : `pnpm test`, `pnpm build`, puis test navigateur intégré réellement exécuté avec Chromium. Les tests peuvent utiliser l'exécutable Node absolu si pnpm est absent, mais consigner la commande exacte. Si le navigateur manque, installer le runtime Playwright selon l'autorisation de l'utilisateur ; ne jamais convertir un test navigateur requis en test ignoré et annoncer la réussite.

Les sorties de tests doivent distinguer les scénarios exécutés, les limites connues et toute couverture absente. L'absence d'erreur TypeScript ne remplace pas l'essai de bout en bout.

## 11. Revue et publication

Avant commit : revue croisée sur validations d'entrée, injection DOM, origine, secrets, état durable avant clic et absence de double soumission ; correction de tous problèmes bloquants. Inspection du diff et fichiers staged pour exclure `data/`, CV réels, credentials, captures ou logs privés. Ne pas écraser les fichiers déjà staged de l'utilisateur ; conserver l'historique/branche existants avant changements de branche. Publier dans le dépôt Anima-Connect existant selon le mandat utilisateur ; attacher toute PR créée au chat. Livraison accompagnée de la commande Windows de démarrage, URL locale, bilan des tests et périmètre exact des formulaires pris en charge.

