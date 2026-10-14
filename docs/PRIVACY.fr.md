# Politique de confidentialité de Fluux Messenger

[English version](PRIVACY.md)

Date d'entrée en vigueur : **1er octobre 2026**

Cette politique couvre Fluux Messenger pour iOS, les ordinateurs et le web.
Fluux est un client XMPP développé par ProcessOne. Vous choisissez votre compte
et votre serveur XMPP ; ProcessOne n'exploite pas ce serveur dans le cadre de
Fluux. ProcessOne exploite le service facultatif de notifications push iOS
décrit ci-dessous.

Responsable de la politique : **ProcessOne SAS, 168, rue Saint-Denis, 75002 Paris
(France)**. Contact confidentialité :
**[contact@process-one.net](mailto:contact@process-one.net)**.

## Votre compte et vos communications

Fluux se connecte au serveur XMPP de votre choix pour vous authentifier et
échanger des messages, des fichiers, des contacts, des avatars, des informations
de présence et des paramètres de compte. Ce serveur, ainsi que ceux de vos
contacts ou salons, traitent les communications que vous envoyez. Leurs
opérateurs définissent leurs propres pratiques de stockage et de conservation ;
consultez votre fournisseur XMPP pour sa politique et la suppression du compte.

Le chiffrement OpenPGP est disponible pour les conversations individuelles.
Lorsqu'il est utilisé, le contenu des messages et les pièces jointes chiffrées
sont chiffrés sur votre appareil avant leur transmission ; les informations de
compte et de routage parviennent toujours aux serveurs. Les salons ne sont pas
chiffrés avec OpenPGP. Les clés publiques et les paramètres synchronisés sont
publiés sur votre compte XMPP ; si vous choisissez la sauvegarde de clé sur le
serveur, la sauvegarde de la clé privée est chiffrée avant son envoi au serveur
XMPP.

## Notifications push iOS facultatives

Les notifications push nécessitent l'autorisation d'iOS et la prise en charge
par votre serveur XMPP. Le réglage push est initialement activé : lorsque
l'autorisation est accordée et que le serveur est compatible, Fluux peut
s'enregistrer automatiquement. Vous pouvez désactiver le push dans
**Réglages → Notifications** et continuer à utiliser l'application.

À l'enregistrement, Fluux envoie le jeton d'appareil APNs et un identifiant
d'installation généré aléatoirement au service push de ProcessOne, via votre
connexion XMPP authentifiée. Votre serveur XMPP fournit l'identité de votre
compte avec cette requête. Le service associe le jeton à votre JID nu (l'adresse
du compte sans le suffixe d'appareil ou de ressource), puis renvoie un nœud push
et, le cas échéant, un secret d'enregistrement. Fluux transmet ces informations
à votre serveur XMPP afin qu'il puisse demander des notifications pour votre
appareil. L'enregistrement est renouvelé à chaque nouvelle session ou changement
de jeton tant que le push reste activé.

Les versions de production utilisent `push.fluux.io` ; les versions
de développement utilisent `pushdev.fluux.io`. Ces identifiants
servent à acheminer les notifications, conformément aux catégories « identifiant
d'appareil » et « identifiant d'utilisateur » du manifeste de confidentialité
iOS, liées à l'utilisateur pour le fonctionnement de l'application.

Votre serveur XMPP fournit les données de notification que ProcessOne transmet
via le service de notifications push d'Apple (APNs). Selon ce serveur, elles
peuvent inclure l'adresse de l'expéditeur et un texte de notification ou un
résumé de message. Il ne faut pas supposer qu'elles ne contiennent aucune
information sur les communications. Le déchiffrement des aperçus OpenPGP décrit
ci-dessous a lieu sur l'appareil ; Fluux ne renvoie pas cet aperçu déchiffré à
ProcessOne.

La désactivation du push pendant que vous êtes connecté demande à votre serveur
XMPP de cesser d'envoyer des notifications au nœud enregistré pour cet appareil.
Après confirmation, Fluux supprime l'enregistrement et le jeton sauvegardés
localement. Cela n'envoie pas de demande de suppression au service push de
ProcessOne. La déconnexion du compte coupe la connexion et efface les
identifiants de connexion, mais n'envoie pas explicitement la requête de
désactivation du push ; l'effacement des données locales du compte ne supprime
pas non plus l'enregistrement du service push. Désactivez le push en étant
connecté avant de vous déconnecter pour demander l'arrêt des notifications.
Supprimer les données locales ne supprime pas votre compte XMPP.

Le service push est hébergé en France par OVH. Il conserve uniquement le jeton
d'appareil et votre JID nu, ensemble. Il supprime les deux lorsque le service
push d'Apple signale que le jeton n'est plus valide, par exemple après la
désinstallation de l'application lorsqu'une tentative ultérieure d'envoi push
le révèle. Sinon, il les conserve au maximum un an après leur dernière
utilisation.

## Aperçus de notifications OpenPGP sur iOS

Cette option distincte, propre à chaque compte, est désactivée par défaut.
L'activer rend accessibles localement à l'extension de notification les
sous-clés de déchiffrement déverrouillées, les informations de clés publiques
et de confiance et un identifiant de connexion au compte, dans un groupe dédié
du trousseau partagé. Cet ensemble est limité à cet appareil et accessible après
son premier déverrouillage. Il est supprimé lorsque vous désactivez les aperçus,
vous déconnectez ou changez de compte.

L'extension se connecte brièvement à votre serveur XMPP par TLS, s'authentifie
et récupère les entrées récentes de l'archive de votre compte pour
l'expéditeur. Elle vérifie et déchiffre localement les messages chiffrés
admissibles, et peut afficher le texte d'un message non chiffré, sans publier
de présence ni de marqueurs de lecture. Elle utilise les noms et
avatars en cache local ; elle ne télécharge pas d'avatars de notification.
Un registre local conserve des identifiants de messages et l'état de lecture
ou de notification, sans corps de message ni secrets. Les entrées de plus de
sept jours expirent lors d'une activité ultérieure du registre ; elles peuvent
donc rester plus longtemps lorsque le registre est inactif. Il est purgé à la
désactivation, à la déconnexion ou au changement de compte.

Les aperçus suivent le réglage iOS **Afficher les aperçus**. **Toujours** peut
afficher le texte déchiffré sur l'écran verrouillé après le premier
déverrouillage ; **Jamais** empêche le déchiffrement des aperçus. L'absence
d'identifiants ou de clés, ou un échec de vérification ou de récupération,
peuvent laisser une notification générique. Le texte de l'aperçu est remis à
iOS pour l'affichage de la notification.

## Données conservées sur votre appareil

Fluux conserve les préférences, brouillons, informations de compte et de session,
contacts et salons, historique des messages, index de recherche, avatars et
médias téléchargés dans le stockage local, IndexedDB, les caches du navigateur
ou les fichiers de l'application native. Les caches locaux de messages et de
médias peuvent contenir des données déchiffrées. Certaines préférences et
certains paramètres de confiance du chiffrement sont également synchronisés
via votre serveur XMPP.

Sur iOS et les ordinateurs compatibles, les identifiants de connexion mémorisés
utilisent le gestionnaire d'identifiants du système. Les identifiants de session
utilisent aussi le stockage de session. Les clés OpenPGP natives utilisent les
fichiers de l'application et la protection du trousseau lorsqu'elle est
disponible ; certains ordinateurs sans trousseau fonctionnel utilisent un fichier
local de secours, avec un avertissement dans l'application. Les clés OpenPGP
sur le web utilisent IndexedDB. Ces stockages locaux ne sont pas envoyés au
service push de ProcessOne.

À la déconnexion, vous pouvez conserver ou effacer les données locales.
L'effacement des données du compte ne supprime pas tous les caches partagés
d'avatars ou de médias, ni toutes les clés OpenPGP ; la suppression des clés
dispose de ses propres commandes dans les réglages de chiffrement. Les copies
sur les serveurs ou les appareils des destinataires échappent au nettoyage local.
Sur iOS, Fluux fournit aussi au système des identités de conversations, des noms
et des images en cache pour l'affichage des notifications et les suggestions de
partage.

## Autres requêtes réseau

- **Fichiers et médias :** les envois utilisent le service HTTP de dépôt de
  fichiers découvert via votre serveur XMPP. Il reçoit les octets du fichier et
  ses métadonnées ; les envois chiffrés utilisent des octets chiffrés et un nom de
  fichier généré. Les téléchargements, avatars distants et images d'aperçu peuvent
  contacter les hébergeurs indiqués par votre serveur ou le contenu des messages.
  Ils peuvent voir votre adresse IP réseau et l'URL demandée. Les réglages de
  chargement automatique contrôlent les médias entrants pris en charge.
- **Aperçus de liens :** sur iOS et ordinateur, envoyer un message non chiffré
  admissible contenant un lien peut récupérer les métadonnées Open Graph du site
  directement depuis votre appareil. Le site lié, et toute destination de
  redirection, peuvent voir votre adresse IP et l'URL demandée même si vous
  n'ouvrez pas le lien. Les métadonnées extraites sont envoyées à la conversation
  via XMPP. L'application web n'effectue pas cette récupération native, mais peut
  charger les images d'aperçu reçues dans les messages.
- **Notifications web :** le push facultatif du navigateur enregistre une URL
  d'abonnement et ses clés de chiffrement et d'authentification auprès de votre
  serveur XMPP, avec le service qu'il annonce et le fournisseur push du
  navigateur, plutôt qu'avec l'enregistrement APNs iOS décrit ci-dessus.
- **Distribution et mises à jour :** l'hébergeur web reçoit les requêtes de
  chargement de l'application et de ses ressources. Les vérifications et
  téléchargements de mises à jour sur les ordinateurs compatibles contactent
  l'infrastructure de distribution de GitHub. Ces services peuvent voir votre
  adresse IP et les informations de requête. La distribution par l'App Store et
  TestFlight relève d'Apple et de ses propres conditions de confidentialité.
- **Automatisation sur ordinateur :** si vous activez l'interface MCP locale et
  confiez son jeton d'accès à un autre programme, celui-ci peut lister les
  conversations, lire l'historique (y compris le texte déchiffré) et envoyer des
  messages. Cette interface est désactivée par défaut ; le programme connecté
  contrôle l'utilisation ultérieure de ces données.

## Analyse d'usage, publicité et demandes de confidentialité

Fluux n'intègre aucun service publicitaire ou d'analyse d'usage, aucune remontée
de télémétrie à distance, ni intégration de signalement automatique des plantages.
L'application conserve des journaux de diagnostic locaux et une console XMPP,
qui peuvent contenir des informations de compte ou de communication. Vous
pouvez exporter vous-même ces diagnostics ; relisez-les avant de les partager.

Pour les demandes concernant les données du service push de ProcessOne,
contactez l'adresse de confidentialité ci-dessus. Pour les messages, fichiers
ou comptes conservés par les fournisseurs de votre choix, contactez ces
fournisseurs.
