/**
 * French translations for tutorial tooltips.
 *
 * Keys match tutorial step IDs from tutorialSteps.ts.
 * Each step has a `content` (main text) and optional `actionHint` (bold CTA).
 */
const tutorialFR = {
  'welcome-hint': {
    content: 'Bienvenue sur Fluux ! Voici votre espace de messagerie — les conversations à gauche, les messages à droite.',
    actionHint: 'Commençons par explorer vos conversations',
  },
  'conversations-hint': {
    content: 'L\'onglet Messages affiche vos conversations individuelles. Emma vient de vous envoyer une capture d\'écran.',
    actionHint: 'Cliquez sur une conversation pour la consulter',
  },
  'rooms-hint': {
    content: 'Les salons sont des conversations de groupe où votre équipe collabore en temps réel.',
    actionHint: 'Cliquez sur l\'icône Salons pour voir ce que fait votre équipe',
  },
  'image-hint': {
    content: 'Les images peuvent être affichées en plein écran avec une option de téléchargement.',
    actionHint: 'Cliquez sur une image pour ouvrir la visionneuse',
  },
  'file-upload-hint': {
    content: 'Vous pouvez partager des fichiers, images et documents avec vos contacts.',
    actionHint: 'Essayez le bouton joindre pour envoyer un fichier',
  },
  'search-hint': {
    content: 'Recherchez des messages dans toutes les conversations. Utilisez les filtres ou « in:Team » pour affiner.',
    actionHint: 'Cliquez sur l\'icône Recherche et essayez « SDK » ou « in:Team »',
  },
  'mention-hint': {
    content: 'Vous avez été @mentionné dans Team Chat — le badge indique les mentions non lues.',
    actionHint: 'Cliquez sur Team Chat pour accéder à votre mention',
  },
  'keyboard-shortcuts-hint': {
    content: 'Fluux offre une navigation clavier complète. Utilisez Cmd+K pour changer de panneau, ou ? pour voir tous les raccourcis.',
    actionHint: 'Appuyez sur ? pour voir les raccourcis clavier',
  },
  'theme-hint': {
    content: 'Personnalisez Fluux — thèmes, couleurs d\'accentuation, polices et plus de 30 langues en un clic.',
    actionHint: 'Ouvrez les Paramètres pour essayer les couleurs, thèmes et le changement de langue',
  },
  'admin-hint': {
    content: 'Le tableau de bord Admin permet aux opérateurs de gérer les utilisateurs, salons et paramètres du serveur.',
    actionHint: 'Cliquez sur l\'icône Admin dans la barre latérale pour explorer',
  },
  'xmpp-console-hint': {
    content: 'Pour les développeurs : la console XMPP affiche tout le trafic protocolaire — stanzas entrants et sortants.',
    actionHint: 'Ouvrez Paramètres > Console XMPP pour voir les paquets en direct',
  },
  'tour-complete': {
    content: 'C\'est la fin de la visite ! Toutes les fonctionnalités sont actives — explorez librement. Profitez de Fluux ! ✨',
  },
  skip: 'Passer',
} as const

export default tutorialFR
