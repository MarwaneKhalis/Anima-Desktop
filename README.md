# Anima Desktop

**Anima Connect, l’application Windows pour organiser et automatiser vos candidatures.**

Gérez votre profil et vos CV, rassemblez des offres, préparez les formulaires de candidature et suivez l’avancement depuis une application installée sur votre PC.

[**Télécharger pour Windows**](https://github.com/MarwaneKhalis/Anima-Desktop/releases/latest/download/Anima-Desktop-Setup.exe) · [Voir les versions](https://github.com/MarwaneKhalis/Anima-Desktop/releases)

![Aperçu du tableau de bord Anima Connect](docs/desktop-preview.png)

_Aperçu avec des données de test._

## Installation

1. Téléchargez **Anima-Desktop-Setup.exe** depuis le lien ci-dessus.
2. Ouvrez le fichier et suivez l’installation.
3. Lancez **Anima Connect** depuis le menu Démarrer ou le raccourci du bureau.

Lancez la version installée par ce programme. Le fichier `Anima Connect.exe` dans `release/win-unpacked` est un artefact de vérification locale, pas le fichier à ouvrir après téléchargement du dépôt.

L’installateur est prévu pour Windows 10/11 64 bits et une installation par utilisateur. Node.js, Chrome et un serveur web ne sont pas nécessaires. L’application enregistre ses données dans le profil Windows local ; un export ou une sauvegarde que vous enregistrez ailleurs peut quitter cet ordinateur. Une connexion Internet est nécessaire pour consulter des offres et ouvrir les sites carrière.

> **À propos de Windows SmartScreen :** les versions actuelles ne sont pas signées par un certificat éditeur. Windows peut afficher un avertissement au premier lancement.

## Ce que l’application fait

- **Centralise le profil et plusieurs CV** pour réutiliser les bonnes informations selon le poste.
- **Recherche les offres automatiquement** dans les flux publics Arbeitnow France, Jobicy, Remote OK, Himalayas et Remotive, sans URL à copier-coller ni clé API. Par défaut, l’app interroge ces cinq sources en parallèle, répartit les résultats et continue si une source est indisponible. Elle regroupe les offres qui partagent le même lien de candidature ou de fiche, tout en gardant l’attribution de chaque résultat. Remotive retarde ses annonces de 24 h et son flux est téléchargé au plus une fois par jour conformément à ses conditions. France Travail reste disponible séparément avec des identifiants API habilités.
- **Lance une campagne de candidatures** depuis les offres trouvées ou enregistrées. Les formulaires reconnus Greenhouse, Lever, Ashby, Recruitee, Workable, SmartRecruiters, Teamtailor et Workday peuvent être remplis et envoyés; le CV et le compte carrière sélectionné sont associés à la campagne.
- **Suit les candidatures** : état, reçu, questions restantes, notes et relances.
- **Met en pause les parcours** qui demandent une réponse, un CAPTCHA ou une vérification MFA ; vous reprenez ensuite dans la session ouverte.
- **Suit la prospection** et les échanges LinkedIn. Les invitations et messages LinkedIn restent envoyés manuellement.
- **Propose un assistant IA optionnel** : configurez un fournisseur compatible OpenAI, testez-le et générez un brouillon de lettre à relire. L’IA ne soumet pas de candidature.

La recherche combinée renvoie au plus 200 offres. Arbeitnow parcourt au plus cinq pages récentes par recherche (450 résultats maximum en recherche individuelle); Jobicy fournit au plus 200 offres distantes des sept derniers jours dont la zone déclarée inclut France, Europe/EMEA ou partout; Remote OK conserve au plus 200 offres de moins de 60 jours explicitement ouvertes à la France ou à une région large compatible; Himalayas renvoie une page de 20 offres par recherche et actualise son cache quotidiennement; Remotive filtre localement son flux public complet, retient les annonces de moins de 90 jours ouvertes à la France, à l’Europe ou partout, et conserve l’annonce d’origine pour l’attribution. Le cache Remotive est persistant entre redémarrages et plafonne les requêtes à une par 24 heures. Ces sources ne représentent pas tout le marché. L’envoi automatique fonctionne seulement sur les formulaires reconnus Greenhouse, Lever, Ashby, Recruitee, Workable, SmartRecruiters, Teamtailor et Workday. Les comptes à créer, SSO, questions inconnues, CAPTCHA/MFA et autres parcours propriétaires demandent une action manuelle; une campagne se met en pause quand le navigateur rencontre un blocage. Vérifiez les résultats et réponses avant de lancer une campagne.

## Données et confidentialité

Dans l’application bureau, le profil, les CV, les réponses et les notes sont chiffrés dans la base locale avec AES-256-GCM. La clé de cette base est protégée par le compte Windows (DPAPI) ; les mots de passe de comptes carrière et les clés API gardent aussi le chiffrement du coffre. Les sauvegardes exportées sont chiffrées avec une phrase secrète distincte que vous choisissez : conservez-la séparément du fichier. Les anciennes sauvegardes SQLite en clair ne sont acceptées qu’après confirmation explicite et sont rechiffrées localement à l’import. Les données de session du navigateur carrière ne sont pas incluses dans la sauvegarde. La version web de développement n’a pas accès à DPAPI.

Le fournisseur IA ne reçoit des informations professionnelles qu’après une action explicite de génération. Les champs structurés de coordonnées et les fichiers CV ne sont pas transmis ; les textes libres du profil ou de l’offre peuvent toutefois contenir des données personnelles. Consultez [les détails sur les données envoyées](docs/AI_PROVIDER.md).

L’application bureau ouvre son interface depuis les fichiers installés et communique avec son moteur par IPC. Elle ne lance pas de serveur web local.

## Développer et vérifier

Prérequis pour contribuer : Windows, Node.js 24 ou supérieur et pnpm 11.19.0.

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm desktop:dist
```

L’installateur généré se trouve dans `release/`. La suite de tests utilise des offres et sites fictifs ; elle n’envoie pas de candidature à un employeur. Voir [l’architecture](docs/CAREER_ARCHITECTURE.md) et [les vérifications](docs/VERIFICATION.md).

