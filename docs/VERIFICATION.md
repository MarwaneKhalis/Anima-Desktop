# Vérification

## Résultats actuels — 9 octobre 2026

La branche desktop intégrée passe **193 tests sur 193**, `pnpm build` et `pnpm desktop:compile`. `pnpm desktop:dist` génère l’installateur NSIS x64. `pnpm desktop:smoke` vérifie le lancement du package dans un profil temporaire Windows, l’embarquement de Chromium, la création de la clé locale, la préparation sans envoi, un seul POST vers le serveur de fixture, le reçu et la persistance de la campagne après redémarrage. Le smoke confirme aussi qu’aucun serveur HTTP n’écoute dans l’application empaquetée. Aucune candidature n’a été envoyée à un employeur.

La recherche publique agrège Arbeitnow, Jobicy, Remote OK, Himalayas et Remotive, garde les sources des annonces et déduplique les résultats. Remotive garde son flux localement, l’actualise au plus une fois par 24 heures, filtre les mots-clés sur l’appareil et conserve uniquement les annonces explicitement ouvertes à la France, à l’Europe/EMEA ou partout. Cette source ne fournit pas la ville. Sa réponse live n’a pas été vérifiée dans ce smoke; les filtres, limites, cache et erreurs sont testés avec des réponses synthétiques.

Les données sensibles conservées dans SQLite sont chiffrées en AES-256-GCM avec une clé protégée par le stockage sécurisé Windows/DPAPI. Le démarrage répare aussi les lignes de candidatures créées par l’ancien mauvais ordre de colonnes, après vérification de la clé; un test couvre la base déjà marquée et la réouverture. Les sauvegardes portables sont chiffrées par phrase secrète et validées avant restauration. L’import d’une ancienne base SQLite nécessite une confirmation explicite.

Le navigateur de candidature utilise un proxy éphémère. À chaque connexion HTTPS, le proxy résout à nouveau le nom, refuse les réponses privées ou mixtes et ouvre TCP vers l’adresse IP validée; TLS reste de bout en bout avec le nom d’hôte original. Remote OK est vérifié par un GET épinglé avant que le navigateur ouvre la destination; seule une URL ATS prise en charge ou une fixture exacte est admise. Les Service Workers et WebSockets externes sont bloqués, QUIC est désactivé et WebRTC est configuré pour ne pas utiliser d’UDP hors proxy. Ces protections Chromium ne constituent pas un pare-feu système : l’application ne garantit pas le confinement d’un navigateur compromis ou d’un transport réseau brut.

Le smoke ATS live est resté en lecture seule sur l’environnement de démonstration public Lever : HTTP 200, lien Apply visible, aucun formulaire chargé, sept requêtes hors politique bloquées. Aucun clic, remplissage ou envoi n’a été effectué. Les adaptateurs Greenhouse, Lever, Ashby, Recruitee, Workable, SmartRecruiters, Teamtailor et Workday sont validés sur des formulaires synthétiques; CAPTCHA, MFA, nouveaux comptes et réponses inconnues demandent toujours l’intervention de l’utilisateur.

L’installateur produit est non signé faute de certificat de signature fourni. La procédure de signature locale est décrite dans [RELEASING.md](RELEASING.md). Les workflows GitHub de cette branche restent à vérifier après sa mise à jour sur le PR.

### Résultats historiques — 7 octobre 2026

Windows, Node.js 24, Chromium Playwright. La suite complète comptait **71 tests réussis, 0 échec, 0 ignoré**. `pnpm build` et `pnpm desktop:compile` réussissaient ; l’installateur NSIS x64 avait été généré.

| Vérification bureau                                        | Résultat                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| Installation NSIS par utilisateur dans un dossier isolé    | Réussie                                                   |
| Démarrage de l’EXE installé avec le sandbox Electron actif | Réussi                                                    |
| Accès AppContainer à `icudtl.dat` et à l’EXE               | ACE `RX` confirmée                                        |
| Préparation sans envoi puis envoi fixture                  | Aucun POST en préparation, un seul POST fixture à l’envoi |
| Reçu et reprise après redémarrage                          | Réussis                                                   |
| Instance unique et écoute HTTP locale                      | Deuxième instance fermée ; aucun serveur HTTP détecté     |

L’installation a été vérifiée dans un chemin isolé du profil Windows courant, pas dans une nouvelle session utilisateur ou une machine virtuelle vierge. L’installateur n’est pas signé par un certificat éditeur ; SmartScreen peut afficher un avertissement. Aucun site carrière réel n’a reçu de candidature pendant les tests.

## Résultats historiques — 6 octobre 2026

## Résultat local

Windows, Node.js 24, Chromium Playwright. TypeScript `--noEmit` et build Vite standard réussis. Suite complète : **50 tests réussis, 0 échec, 0 ignoré**, durée 49,6 secondes sur la dernière exécution après intégration des commits.

| Vérification                    | Preuve                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Candidature simple et CV choisi | POST reçu par le serveur fictif ; fichier, MIME, octets et SHA-256 comparés                                     |
| Préparation                     | Aucun POST final avant lancement de l'envoi                                                                     |
| Plusieurs étapes                | Identité → CV/question → récapitulatif → reçu                                                                   |
| Connexion et redirection ATS    | Compte fourni uniquement à l'origine exacte du site de destination                                              |
| Réponses personnelles           | Champs inconnus bloqués, defaults ignorés, radios Yes/No cohérents, réponses candidature prioritaires           |
| Secret                          | Chiffrement authentifié, altération rejetée, espaces conservés, aucun mot de passe dans API/disque/log d'erreur |
| Envoi incertain                 | Un POST sans reçu → uncertain ; nouvel envoi refusé après redémarrage                                           |
| Interruption/concurrence        | État durable avant clic, stop avant/après clic, deuxième parcours HTTP 409                                      |
| Fichiers                        | PDF/DOCX ; upload HTTP 5 Mio ; limite 10 Mio ; nom Unicode téléchargé                                           |
| Interface                       | Profil, deux CV, choix explicite, offre, préparation, envoi, reçu, reload et deux lots successifs               |
| Mobile/CRM                      | Vue 390 × 844 sans débordement ; prospection intégrée avec une seule barre latérale                             |
| API locale                      | Header de mutation, Origin, Host hostile et Sec-Fetch-Site contrôlés                                            |
| Ancienne prospection            | Les neuf tests métier existants réussissent                                                                     |

L'architecte a revu les branches avant commit, fait reproduire puis corriger les défauts et donné son accord final. Son contrôle indépendant de restauration a vérifié le retour du profil, des octets/SHA du CV, du compte chiffré et du coffre verrouillé puis déverrouillable avec sa phrase originale.

## Découverte réelle, en lecture seule

Le 6 octobre 2026, le moteur a lu les tableaux publics :

- Greenhouse Figma : **162 offres** trouvées.
- Lever Spotify : **80 offres** trouvées.

Ces nombres sont un constat de test, pas des données de démonstration permanentes. La découverte JSON-LD et le refus des redirections vers des adresses privées sont couverts par un serveur local fictif.

## Captures reproductibles

`tests/career-ui.test.ts` génère les captures suivantes dans `artifacts/career-ui/` :

1. `01-dashboard.png`
2. `02-profile.png`
3. `03-offers.png`
4. `04-application-ready.png`
5. `05-receipt.png`
6. `06-mobile.png`
7. `07-prospecting.png`

Les captures proviennent d'une exécution réelle sur données synthétiques. Elles sont exclues de Git et conservées comme artefact par la CI.

## Portée des résultats

Aucune candidature de test n'a été envoyée à un employeur réel. La réussite sur les fixtures ne certifie pas tous les portails de recrutement. Les contrôles CAPTCHA/MFA, SSO, nouveaux comptes et formulaires propriétaires non reconnus demandent une intervention. La prospection LinkedIn garde l'envoi manuel de la version précédente ; les résultats métier des candidatures se renseignent manuellement. Ces limites sont visibles dans l'interface et décrites dans le README.
