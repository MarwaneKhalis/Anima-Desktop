# Anima Desktop — suivi de rationalisation

Base examinée : `a9f3014e776f2935c5b0c7bf209509ee8a138faf` (`v0.4.2`). Cible de cette branche : `0.4.3`.

`Vérifié` signifie que le critère d’acceptation complet a été exercé. Les contrôles d’une tranche ou les tests sur fixtures ne suffisent pas à l’affirmer.

| Réf. | Priorité | Statut | Preuves et reste à faire |
| --- | --- | --- | --- |
| R01 | P1 | En cours | Enveloppe et espace de prospection extraits ; l’espace intégré n’affiche plus sa propre navigation ni son `<main>`. Vérifier chaque ancien écran et ses dialogues dans l’app empaquetée. |
| R02 | P1 | En cours | Navigation principale regroupée sous Aujourd’hui, Offres, Candidatures, Réseau, Profil & CV ; Paramètres et Aide sont secondaires. Vérifier les destinations et réglages dans l’app Windows installée. |
| R03 | P1 | En cours | Le champ métier/mot-clé est maintenant visible avant l’ouverture des filtres avancés ; résultats en premier et captures de test à 1366×768 et 390 px. Test UI vérifie la découvrabilité initiale. Vérifier les états vides, clavier, zoom et DPI. |
| R04 | P1 | En cours | Récapitulatif avant lancement partagé et mode de préparation sans envoi par défaut ; après CAPTCHA/MFA, la reprise surveille les soumissions finales manuelles, ignore les vérifications OTP et clics bloqués par la validation HTML, puis vérifie l’état et déclenche le clic automatisé dans une seule tâche pour fermer la course au double envoi. Compatibilité des portails réels non établie. |
| R05 | P1 | En cours | CV choisi transmis et persisté pour une candidature et une campagne ; compte lié porté jusqu’au moteur. Le parcours automatisé a été exercé sur fixture. |
| R06 | P1 | En cours | Campagnes durables, paginées et comptées, avec reprise/arrêt et prévention des doublons. Reste à contrôler leur découverte et leurs actions dans toutes les sections UI. |
| R07 | P1 | En cours | États, erreurs et prochaine action apparaissent sur les fiches ; les notes de suivi éditables après envoi gagnent une entrée chronologique sans recopier leur contenu sensible. Le suivi employeur reste peu structuré. |
| R08 | P1 | En cours | Aujourd’hui trie l’incertain puis les blocages, présente les relances échues par échéance pour les candidatures actives, en entretien ou avec offre, compare l’instant exact en tenant compte des fuseaux, omet les rappels futurs et évite le doublon entre blocage et rappel. Un accès « Voir les relances dues » ouvre la liste complète ; tests unitaires et parcours UI dédiés. Contrôler après restauration et dans l’app installée. |
| R09 | P1 | En cours | Nom affiché et installateur passent à Anima Desktop ; appId, `userData` existant, SQLite, coffre et clés restent inchangés. La CI 0.4.0 a vérifié la mise à niveau depuis v0.3.0. Les CI 0.4.1 et 0.4.2 vérifient une mise à niveau depuis un installeur officiel antérieur et la conservation du répertoire utilisateur ; un test réel avec une base/coffre utilisateur demeure à faire. La prochaine vérification sera faite depuis v0.4.2. |
| R10 | P1 | En cours | Libellés d’état communs et résultat employeur séparé de l’automatisation. Une taxonomie centrale complète des opérations reste à faire. |
| R11 | P2 | En cours | Filtre texte et rangement des listes présents ; critères et cadence des recherches récurrentes maintenant modifiables depuis leur liste. Filtres métier, tri choisi et vues compactes restent limités. |
| R12 | P2 | En cours | Score indicatif de recouvrement de mots-clés expliqué, sans prédire une embauche ; date « Repérée par Anima » basée sur la découverte locale et dernière collecte visibles. Aucune date de publication fiable n’est disponible. |
| R13 | P2 | En cours | Profil éditable par sections ; vérifier conservation des brouillons et erreurs sur les transitions et après redémarrage. |
| R14 | P2 | En cours | Réponses explicites et consentements préservés ; catalogue des réponses réutilisables et flux d’édition à rationaliser. |
| R15 | P2 | En cours | Prospects et candidatures peuvent être associés ; actualisation, contexte de liste et dédoublonnage complet restent à contrôler. |
| R16 | P2 | En cours | Messages d’erreur filtrés, erreurs de collecte affichées et reprise possible ; harmonisation de toutes les opérations encore incomplète. |
| R17 | P2 | En cours | Réglages IA rangés sous Connexions ; persistance et édition chiffrée des brouillons de lettres à vérifier/compléter. |
| R18 | P2 | En cours | Contacts, recherches LinkedIn et messages sont regroupés dans Réseau ; les invitations/messages demeurent manuels. Vérifier le parcours de bout en bout. |
| R19 | P2 | En cours | Sauvegarde, restauration, mode démo et aide rangés dans les sections secondaires ; scénario de restauration dans l’app empaquetée non démontré ici. |
| R20 | P3 | En cours | Tokens visuels communs et accents discrets par section : Weltall, Weltall-2, Weltall-Id, Xenogears. Vérifier contraste mesuré et cohérence de tous les états. |
| R21 | P2 | En cours | Captures viewport bureau et mobile disponibles ; clavier, focus, lecteur d’écran, contrastes mesurés et facteurs d’échelle Windows restent à valider. |
| R22 | P3 | En cours | Coquille et espace historique séparés progressivement avec ré-export de compatibilité ; aucune réécriture métier étendue. D’autres découpages doivent être justifiés par les prochaines évolutions. |

## Vérifications de cette tranche

- `pnpm test` : 213 tests réussis, 0 échec (dont le non-redémarrage automatique d’une campagne restaurée, les raccourcis de navigation et l’édition d’une recherche récurrente).
- `pnpm build` et `pnpm desktop:compile` : réussis après les changements UI et serveur.
- Parcours navigateur R04 : 50 tests réussis, dont les soumissions manuelles pendant une intervention, un OTP MFA, et un clic final invalide ; typechecks web/desktop et build de production réussis.
- `git diff --check` : réussi.
- Un installateur Windows local v0.4.0 avait extrait son payload, puis NSIS signalait un abandon parce que le `icacls /T` post-install rencontrait un fichier Chromium temporaire disparu. La correction retire le parcours récursif après avoir confirmé que l’ACE AppContainer héritée est présente sur `icudtl.dat`. Le runner GitHub Windows a réussi la mise à niveau depuis l’installateur officiel v0.3.0, le smoke test de l’application mise à niveau et une installation neuve avec smoke test. La CI du hotfix v0.4.1 reteste la mise à niveau depuis v0.4.0 ; la CI v0.4.2 l’a aussi validée depuis v0.4.0 (et non depuis v0.4.1). La branche v0.4.3 prépare le test depuis la release officielle v0.4.2. Le smoke test local reste empêché par l’indisponibilité de DPAPI dans cet environnement Codex.
- Aucune candidature, invitation ou aucun message réel envoyé. Aucun portail de recrutement réel n’a été déclaré compatible sur la base des fixtures.

## Points substantiels encore ouverts

- Les retours d’employeur restent dans une note libre : date/canal/type de réponse ne sont pas structurés et la fraîcheur des offres n’est pas une date fournie par l’employeur.
- Les critères et la cadence d’une recherche enregistrée peuvent maintenant être modifiés dans l’interface. L’édition reste à vérifier avec une collecte en cours et dans l’app empaquetée.
- Validation clavier/lecteur d’écran/contraste/DPI complète et restauration dans l’app empaquetée restent à prouver. Le hotfix empêche les campagnes d’une sauvegarde restaurée de repartir automatiquement ; la CI vérifie l’installation neuve et met à niveau l’installateur v0.4.0 avant la publication.
- Une partie des recommandations P2/P3 reste partielle ; ce lot ne prétend pas achever l’audit R01–R22 ni garantir une compatibilité générale des portails.

## Direction visuelle

Base neutre et cohérente. Accents par section : Profil & CV → Weltall ; Offres → Weltall-2 ; Candidatures/Campagnes → Weltall-Id ; Aujourd’hui/relances → Xenogears, le Gear de Fei. Garder les couleurs de statut accessibles et distinctes de l’accent Weltall-Id.
