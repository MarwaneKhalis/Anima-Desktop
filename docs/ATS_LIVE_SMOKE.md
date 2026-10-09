# Smoke ATS public, lecture seule

Cette commande vérifie ponctuellement le chargement anonyme d'une URL d'offre fournie explicitement par l'utilisateur. Elle ne remplit aucun formulaire et ne vérifie pas qu'une candidature peut être envoyée.

## Lancer le contrôle

Après installation des dépendances et du navigateur Playwright dans le dépôt :

    pnpm install --frozen-lockfile
    pnpm desktop:browser
    pnpm ats:live-smoke -- https://boards.greenhouse.io/entreprise/jobs/123

Plusieurs URL peuvent être fournies. La commande accepte seulement HTTPS, les hôtes ATS publics reconnus par l'application, sans identifiants intégrés, paramètres de requête ni port personnalisé. Une URL avec query string est rejetée avant toute requête, ce qui évite d'envoyer ou d'exposer un éventuel jeton. Le délai par défaut est de 15 secondes par page; --timeout-ms accepte de 1 à 60 secondes. La limite est de 20 URL par exécution.

Cette commande est manuelle et n'est appelée ni par la suite de tests ni par la CI. Ne la lancez que sur des URL publiques fournies pour ce contrôle.

## Garanties et limites

- Contexte Playwright temporaire sans état de connexion importé, permissions, profil, CV ni données de l'application.
- Aucune saisie, aucun clic, aucun upload et aucun clic Apply ou Submit. Le script inspecte seulement des indicateurs visibles.
- Les requêtes HTTP autres que GET sont bloquées avant envoi. Les navigations non initiales hors redirections HTTP sont bloquées. Les WebSockets sont fermés et les Service Workers désactivés.
- Toute URL fournie avec paramètres de requête est rejetée avant le contrôle DNS ou l'ouverture du navigateur.
- Chromium passe par un proxy local éphémère. Pour chaque tunnel HTTPS, celui-ci résout le nom, rejette toute réponse DNS non publique (y compris une réponse mélangée public/privé), puis se connecte à l'adresse IP résolue; TLS reste chiffré de bout en bout vers l'ATS.
- Les règles Chromium bloquent sa résolution DNS directe, QUIC et WebRTC UDP hors proxy. Le proxy est fermé après l'inspection ou en cas d'erreur.
- Les GET sont limités à l'ATS fourni et aux assets Greenhouse explicitement permis. Les autres origines sont bloquées. L'allowlist du proxy n'ajoute un hôte qu'après validation par cette règle, ce qui bloque aussi les connexions de fond de Chromium. Les en-têtes Cookie, Authorization, Proxy-Authorization et Referer sont retirés.
- Le JSON ne contient que l'index d'entrée, l'ATS, l'hôte, l'état, le statut HTTP, deux indicateurs booléens et les compteurs de requêtes bloquées. Il ne contient ni URL complète, titre d'offre, texte de page, HTML, nom/valeur des champs, cookie ou jeton.
- **accessible** signifie que le document public a répondu; les booléens indiquent seulement si un lien Apply visible ou un formulaire visible a été détecté. Cela ne garantit pas que toutes les étapes de candidature fonctionnent.
- **login**, **captcha** et **inaccessible** sont des observations, pas des tentatives de contournement. Le script ne tente ni connexion ni résolution de CAPTCHA.
- L'ouverture envoie les GET habituels d'une page et le site peut enregistrer la visite. L'application ne transmet aucune donnée du profil, mais le smoke ne peut garantir le comportement interne du serveur ATS.
- Le mode lecture seule ne valide pas l'envoi. Un test d'envoi de bout en bout exige un tenant de test contrôlé et des données synthétiques; ne testez jamais l'envoi sur une offre publique réelle.

## Format du rapport

La sortie standard est un JSON horodaté avec un résultat par URL, dans le même ordre que les arguments. Les états sont **accessible**, **inaccessible**, **login**, **captcha** et **rejected**. Les raisons sont des codes génériques; aucun message d'erreur brut du navigateur ni URL complète n'est écrit.
