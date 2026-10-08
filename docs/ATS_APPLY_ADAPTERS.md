# ATS de candidature pris en charge

## Périmètre actuel

Le navigateur sait ouvrir les parcours publics Greenhouse et Lever, suivre un unique lien de candidature visible, attendre les scripts de formulaire chargés depuis l’ATS, puis appliquer les règles de remplissage déjà utilisées par l’application.

- Greenhouse : `boards.greenhouse.io`, `job-boards.greenhouse.io`, `boards.eu.greenhouse.io`.
- Lever : `jobs.lever.co`, `jobs.eu.lever.co`.

Les liens vers des formulaires hébergés ailleurs, les domaines personnalisés et les formulaires génériques ne reçoivent aucune donnée du profil. Les contrôles externes sont bloqués sauf ressources passives explicitement autorisées : pages du même ATS, et CSS/polices Greenhouse sous `/assets/` sur `static.greenhouse.io`, sans chaîne de requête. Les scripts, pixels, POST, XHR, fetch et documents tiers sont bloqués.

## Formulaires observés en lecture seule

Les résultats publics indexés de pages Greenhouse montrent les champs First Name, Last Name, Email, Phone, Resume/CV, puis des questions propres à chaque employeur. Les pages de candidature Lever montrent Resume/CV, Full name, Email, Phone, parfois Current company, liens, questions sur mesure et une action Submit application. Certains parcours présentent aussi un CAPTCHA ou une vérification anti-robot.

Exemples publics consultés : [formulaire Greenhouse Study.com](https://boards.greenhouse.io/embed/job_app?token=4126095008), [formulaire Greenhouse Opendoor](https://boards.greenhouse.io/embed/job_app?token=4572025006), [formulaire Lever Match Group](https://jobs.lever.co/matchgroup/4b304f3c-a2fd-426c-8988-727a5e16bd26/apply) et [formulaire de démonstration Lever](https://jobs.lever.co/leverdemo-8/c737ad83-0a87-4472-9ec3-1813ca12f7fa).

La lecture directe des pages d’exemple a renvoyé une erreur 404 ou une protection anti-robot. Les tests utilisent donc des fixtures Playwright synthétiques reproduisant seulement les structures visibles et courantes ci-dessus; elles ne sont pas des copies du DOM privé ou d’un compte employeur. Aucun dossier réel n’a été envoyé.

## Arrêts de sécurité et limites

- Le navigateur s’arrête si le lien Apply est absent ou ambigu, si le formulaire est ambigu, ou si un champ obligatoire n’a pas une réponse explicite et concordante.
- Un CAPTCHA, une MFA, une vérification anti-robot, une question d’éligibilité ou une pièce jointe inconnue exige l’intervention de l’utilisateur. Aucun mécanisme ne contourne ces protections.
- Les CV et données personnelles ne sont envoyés qu’à l’origine ATS autorisée du formulaire. Les identifiants ne sont fournis qu’à cette origine exacte via le coffre existant.
- Les limites de débit, formulaires expirés, authentifications SSO, parcours personnalisés par employeur, widgets tiers et changements de DOM peuvent arrêter le parcours. Le navigateur rend alors la main sans réessayer l’envoi.
- L’envoi en mode « préparer » ne soumet jamais le formulaire. En mode d’envoi, l’idempotence et le reçu vérifiable existants restent appliqués; un résultat sans reçu reste incertain et ne doit pas être relancé automatiquement.

Ces adaptateurs ne signifient pas que tous les formulaires hébergés par ces fournisseurs sont compatibles. Les questions spécifiques à l’offre et les valeurs sensibles restent à confirmer au cas par cas.
