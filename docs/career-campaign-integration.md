# Intégration du moteur de campagne durable

`server/career-campaign.ts` fournit une file SQLite indépendante de React. Le module est
volontairement injecté : il ne construit pas le navigateur, ne découvre pas les offres et
n’envoie aucun formulaire sans que l’hôte lui fournisse explicitement un parcours.

## Contrat d’hôte

Créer `CareerCampaignStore` sur le même `DatabaseSync` que le magasin carrière, puis un
`CareerCampaignEngine` avec un `CampaignApplicationPort` qui délègue `createApplication`
à `CareerStore.createApplication`, `getApplication` à `CareerStore.getApplication` et
`run` au runner de candidature déjà existant. `createApplication` est idempotent par offre
grâce à la contrainte unique du magasin carrière.

Après une découverte et avant la fermeture de sa vue, appeler
`engine.createFromOffers(offers, resumeId, maxSubmissions, idempotencyKey, credentialId)` avec une clé stable
générée pour l’action utilisateur (UUID côté client). `credentialId` est facultatif et désigne un
compte carrière enregistré ; le runner ne l’utilise que si le compte correspond à l’origine du site.
Le serveur garde la campagne en état
`building` tant que le lot n’est pas entièrement inséré, puis la scelle en `queued`. La clé d’idempotence
est liée dès la création à la séquence exacte d’IDs d’offres dédupliquée, dans l’ordre de pertinence reçu;
une répétition réduite, étendue ou réordonnée est refusée, y compris pendant une construction partielle.
L’ordre est conservé dans la file afin que le plafond de candidatures respecte le classement affiché. Une panne entre création
d’application et insertion de queue se répare en répétant le même appel. La migration renseigne la séquence
connu des anciennes files; si une ancienne file partielle ne permet pas de vérifier le retry, la requête
échoue sans modifier ses lignes. `addOffers(id, offers)` n’accepte que `building`/`queued` et scelle le lot
après ajout; elle refuse les campagnes démarrées ou terminales. La campagne et chaque application
sont écrites en SQLite.
Le plafond est entre 1 et 500; la concurrence est limitée à 1–4 (valeur par défaut : 1). La
recherche Arbeitnow renvoie au plus 450 résultats des pages parcourues.

Au démarrage du processus, exécuter d’abord `CareerStore.recoverInterruptedRuns()`, puis
`await engine.recoverAfterRestart()` (ou lancer cette promesse en tâche de fond avec journalisation).
La demande de démarrage est persistée avant l’activation : un crash dans cet intervalle laisse une
campagne `queued` avec `startRequested=true`, qui est également reprise. Les campagnes qui étaient
`running` sont réconciliées puis reprennent sans dépendre du montage React. Les campagnes
explicitement `paused` avec un item en cours sont réconciliées (pending ou uncertain) mais restent
en pause et ne reprennent pas seules. Le moteur marque `submitting` ou `uncertain` comme incertain,
met la campagne en pause et ne réappelle jamais le port pour cet item ni les offres suivantes avant
résolution humaine. La résolution « envoyée » réconcilie et compte l’item comme submitted; « non envoyée »
le marque failed, sans le rejouer. L’utilisateur peut reprendre explicitement les autres offres après
résolution.

`pause(id)` (pause manuelle) empêche les nouvelles prises de file, efface l’intention de reprise
automatique et laisse finir les actions en cours.
`stop(id)` annule les signaux en cours et rend la campagne terminale. `start(id)` reprend une
campagne en pause. Chaque exception est contenue à l’item. Une question de formulaire sans
réponse (`needs_input`) laisse les autres offres continuer. Un blocage du navigateur (`blocked`),
comme un CAPTCHA, une MFA, un site non pris en charge ou une action ambiguë, met toute la
campagne en pause pour éviter de laisser le navigateur dans un état inattendu.

Pour l’API, `store.list(limit = 50)` renvoie les campagnes modifiées récemment, de la plus récente
à la plus ancienne, avec un maximum strict de 100; `store.counts(id)` renvoie
`{total,pending,running,submitted,needsInput,uncertain,failed,skipped}`.

## Frontière de sûreté et tests

Le moteur ne prétend pas rendre compatibles tous les ATS : c’est l’adaptateur `run` qui doit
utiliser les parcours reconnus. Il doit respecter le marqueur de soumission existant et renvoyer
`uncertain` si le résultat ne peut pas être confirmé. Le plafond réserve atomiquement une place
avant exécution; un résultat incertain compte dans ce plafond et n’est jamais rejoué. Les tests
`tests/career-campaign.test.ts` emploient SQLite sur disque et des parcours de fixture seulement;
aucune offre réelle ni aucun employeur n’est contacté.

## API séparée

`server/career-campaign-runtime.ts` branche le moteur sur le `CareerRunner` réellement utilisé
par l’application. `server/index.ts` monte l’API campagne avant l’API carrière, réconcilie puis
reprend les campagnes au démarrage et met en pause proprement les files à l’arrêt ou avant une
restauration de sauvegarde. Le runner traite un seul navigateur à la fois et ferme son contexte
après un formulaire qui réclame une réponse manuelle, afin de permettre aux autres offres de
continuer. Une pause automatique causée par un blocage conserve l’intention de reprise jusqu’au skip;
une reprise après skip n’a lieu que si le navigateur est libre. Une pause manuelle n’est jamais relancée
par un skip.

La recherche laisse choisir `ArbeitnowFranceDiscovery` ou `JobicyRemoteDiscovery` : mots-clés,
commune et contrat facultatifs → flux public sélectionné → offres filtrées localement et
dédupliquées, enregistrées dans `CareerStore` → campagnes durables. Arbeitnow parcourt au plus cinq
pages de 100 annonces, renvoie au plus 450 résultats et met chaque page en cache dix minutes. Jobicy
demande au plus 200 offres distantes publiées dans les sept derniers jours et conserve celles dont
la zone déclarée inclut France, Europe/EMEA ou partout ; la réponse est mise en cache une heure.
Ces sources ne couvrent pas tout le marché. L’interface
conserve le lien vers la source et le lien de retour demandé par Arbeitnow.
`FranceTravailDiscovery` reste disponible en option pour les personnes disposant d’identifiants
habilités ; la recherche publique n’en dépend pas. L’envoi automatique est limité aux formulaires
Greenhouse, Lever, Ashby, Recruitee, Workable, SmartRecruiters, Teamtailor et Workday reconnus. Les autres sites, redirections non prises en charge, CAPTCHA/MFA
et questions sans réponse nécessitent une intervention humaine et peuvent mettre la campagne en pause.

`server/career-campaign-api.ts` expose `handleCareerCampaignApi` avant l’API carrière. Il reçoit
`{careerStore,campaigns,engine,demo}` et offre :

- `GET /api/career/campaigns?limit=50` → `{campaigns:[{...campaign,counts}]}` (limite max 100)
- `GET /api/career/campaigns/:id` → `{campaign:{...campaign,counts},items}`
- `POST /api/career/campaigns` → `{jobIds,resumeId,maxSubmissions,idempotencyKey}`
- `POST /api/career/campaigns/:id/items/:itemId/skip` → marque comme ignoré un item éligible en
  attente, en échec ou nécessitant une réponse. Un item en cours, en soumission, envoyé ou incertain
  ne peut pas être ignoré.
- `POST /api/career/campaigns/:id/start|pause|stop` avec `{}` et l’en-tête `X-Anima-Request: 1`

`start` répond 202 sans attendre la campagne et intercepte les rejets en arrière-plan; les états
terminaux répondent 200 sans redémarrer. `stop` attend la fin du worker avant de répondre. La démo
refuse création et démarrage. Les tests HTTP associés sont dans `tests/career-campaign-api.test.ts`.

