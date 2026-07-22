// ====================================================================
//  KoZons — Service Worker (PWA installable + fonctionnement hors-ligne)
// ====================================================================
//  ⚠️ Change ce numéro de version à chaque nouveau déploiement du site
//  pour forcer les navigateurs à récupérer les nouveaux fichiers.
const VERSION = 'kozons-v59';

const FICHIERS_A_METTRE_EN_CACHE = [
  '/',
  '/accueil',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/api.js',
  '/js/firebase-config.js',
  '/js/supabase-client.js',
  '/kozons_logo.png',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (evenement) => {
  evenement.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(FICHIERS_A_METTRE_EN_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (evenement) => {
  evenement.waitUntil(
    caches.keys().then((noms) =>
      Promise.all(noms.filter((nom) => nom !== VERSION).map((nom) => caches.delete(nom)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (evenement) => {
  const requete = evenement.request;

  // On ne touche jamais aux appels vers Firebase/Firestore/Supabase :
  // ils gèrent leur propre logique réseau et cache (Firestore a son propre
  // cache hors-ligne, activé séparément dans firebase-config.js).
  if (requete.url.includes('firestore.googleapis.com') ||
      requete.url.includes('supabase.co') ||
      requete.url.includes('googleapis.com') ||
      requete.method !== 'GET') {
    return;
  }

  // Pages HTML (navigation entre onglets, ex: /profil, /groupes...) :
  // on essaie le réseau en premier pour avoir la dernière version du site,
  // et on retombe sur la page d'accueil mise en cache si hors-ligne.
  if (requete.mode === 'navigate') {
    evenement.respondWith(
      fetch(requete).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Fichiers statiques (CSS, JS, images) : cache d'abord pour la rapidité,
  // avec mise à jour silencieuse en arrière-plan.
  evenement.respondWith(
    caches.match(requete).then((reponseEnCache) => {
      const recuperationReseau = fetch(requete).then((reponse) => {
        if (reponse.ok) caches.open(VERSION).then((cache) => cache.put(requete, reponse.clone()));
        return reponse;
      }).catch(() => reponseEnCache);
      return reponseEnCache || recuperationReseau;
    })
  );
});
