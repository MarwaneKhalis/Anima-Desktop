# ATS de candidature pris en charge

## Périmètre actuel

Le navigateur sait ouvrir les parcours publics Greenhouse, Lever, Ashby, Recruitee, Workable, SmartRecruiters et Teamtailor, suivre un unique lien de candidature visible, attendre les scripts de formulaire chargés depuis l’ATS, puis appliquer les règles de remplissage déjà utilisées par l’application.

- Greenhouse : `boards.greenhouse.io`, `job-boards.greenhouse.io`, `boards.eu.greenhouse.io`.
- Lever : `jobs.lever.co`, `jobs.eu.lever.co`.
- Ashby : `jobs.ashbyhq.com`.
- Recruitee : `entreprise.recruitee.com` et `entreprise.s.recruitee.com`.
- Workable : `apply.workable.com` et `entreprise.workable.com`.
- SmartRecruiters : `jobs.smartrecruiters.com` et `careers.smartrecruiters.com`.
- Teamtailor : hôtes carrière hébergés sous `entreprise.teamtailor.com` (un sous-domaine d’entreprise).

Le flux officiel Recruitee expose l’URL de la page d’offre et l’URL de candidature (`apply_url`) ;
sa documentation d’API confirme aussi le domaine carrière de l’entreprise. L’application suit le
lien Apply visible dans la page et remplit le formulaire public same-origin ; elle n’appelle pas
l’API de création de candidat directement. Voir le [schéma de flux Recruitee](https://docs.recruitee.com/docs/feed)
et la [documentation des candidatures](https://docs.recruitee.com/reference/offersoffer_idcandidates).

Workable documente les pages carrière sous `apply.workable.com/{entreprise}` et les sous-domaines de compte
`{entreprise}.workable.com`; ses offres publiques utilisent des shortlinks `/j/{shortcode}`. L’application suit
le lien Apply visible et remplit le formulaire public. Elle n’appelle pas l’API de création de candidat, qui
requiert un jeton avec le scope `w_candidates`. Voir la [convention de sous-domaine Workable](https://help.workable.com/hc/en-us/articles/5270992137751-Where-can-I-find-my-account-subdomain),
la [référence du formulaire](https://workable.readme.io/reference/jobsshortcodeapplication_form) et la [création de candidats](https://workable.readme.io/reference/job-candidates-create).

SmartRecruiters documente les pages d’offres `jobs.smartrecruiters.com/{entreprise}/…`, les pages carrière
`careers.smartrecruiters.com/{entreprise}` et une `applyUrl` publique vers le parcours de candidature. Le navigateur
suit le lien visible « I’m interested » ou Apply sur ces hôtes et ne fait pas d’appel direct à l’Application API,
qui exige un en-tête `X-SmartToken`. Voir les [objets de publication](https://developers.smartrecruiters.com/docs/objects),
la [référence de création de candidature](https://developers.smartrecruiters.com/reference/createcandidate-1)
et le [guide de soumission](https://developers.smartrecruiters.com/docs/post-an-application).

Teamtailor documente l’URL de formulaire publique sous la forme `/jobs/{identifiant-et-titre}/applications/new` et expose
`careersite-job-apply-url` dans son API publique. Le navigateur reste sur l’hôte exact d’entreprise en `*.teamtailor.com`,
reconnaît ce chemin même si le libellé du bouton a été personnalisé et remplit la page publique; il n’appelle pas l’API,
qui demande une clé d’accès. Les domaines carrière personnalisés des employeurs ne sont pas déduits. Voir la
[documentation française sur le formulaire de candidature](https://support.teamtailor.com/fr/articles/4855801-redirigez-votre-site-carriere)
et la [documentation API Teamtailor](https://docs.teamtailor.com/).

Les liens vers des formulaires hébergés ailleurs, les domaines personnalisés et les formulaires génériques ne reçoivent aucune donnée du profil. Les contrôles externes sont bloqués, sauf ressources passives en GET sous l’origine ATS exacte et CSS/polices Greenhouse sous `/assets/` sur `static.greenhouse.io`, sans chaîne de requête. Les scripts, pixels, POST, XHR, fetch et documents tiers sont bloqués.

## Formulaires observés en lecture seule

Les résultats publics indexés de pages Greenhouse montrent les champs First Name, Last Name, Email, Phone, Resume/CV, puis des questions propres à chaque employeur. Les pages de candidature Lever montrent Resume/CV, Full name, Email, Phone, parfois Current company, liens, questions sur mesure et une action Submit application. Ashby, Recruitee, Workable, SmartRecruiters et Teamtailor utilisent également des formulaires variables selon l’employeur. Certains parcours présentent un CAPTCHA ou une vérification anti-robot.

Exemples publics consultés : [formulaire Greenhouse Study.com](https://boards.greenhouse.io/embed/job_app?token=4126095008), [formulaire Greenhouse Opendoor](https://boards.greenhouse.io/embed/job_app?token=4572025006), [formulaire Lever Match Group](https://jobs.lever.co/matchgroup/4b304f3c-a2fd-426c-8988-727a5e16bd26/apply) et [formulaire de démonstration Lever](https://jobs.lever.co/leverdemo-8/c737ad83-0a87-4472-9ec3-1813ca12f7fa).

La lecture directe des pages d’exemple a renvoyé une erreur 404 ou une protection anti-robot. Les tests utilisent donc des fixtures Playwright synthétiques reproduisant seulement les structures visibles et courantes ci-dessus; elles ne sont pas des copies du DOM privé ou d’un compte employeur. Pour Ashby, la fixture couvre le lien Apply depuis une offre Jobicy, le CAPTCHA, les réponses requises inconnues et l’envoi confirmé. Pour Recruitee, Workable, SmartRecruiters et Teamtailor, les fixtures valident le lien public, la pause sur question inconnue, la préparation sans envoi et l’envoi confirmé. La fixture Teamtailor utilise un libellé personnalisé et l’URL documentée `/applications/new`. Aucun dossier réel n’a été envoyé.

## Arrêts de sécurité et limites

- Le navigateur s’arrête si le lien Apply est absent ou ambigu, si le formulaire est ambigu, ou si un champ obligatoire n’a pas une réponse explicite et concordante.
- Un CAPTCHA, une MFA, une vérification anti-robot, une question d’éligibilité ou une pièce jointe inconnue exige l’intervention de l’utilisateur. Aucun mécanisme ne contourne ces protections.
- Les CV et données personnelles ne sont envoyés qu’à l’origine ATS autorisée du formulaire. Les identifiants ne sont fournis qu’à cette origine exacte via le coffre existant.
- Les limites de débit, formulaires expirés, authentifications SSO, parcours personnalisés par employeur, widgets tiers et changements de DOM peuvent arrêter le parcours. Le navigateur rend alors la main sans réessayer l’envoi.
- L’envoi en mode « préparer » ne soumet jamais le formulaire. En mode d’envoi, l’idempotence et le reçu vérifiable existants restent appliqués; un résultat sans reçu reste incertain et ne doit pas être relancé automatiquement.

Ces adaptateurs ne signifient pas que tous les formulaires hébergés par ces fournisseurs sont compatibles. Les questions spécifiques à l’offre et les valeurs sensibles restent à confirmer au cas par cas.
