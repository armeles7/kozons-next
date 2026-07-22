import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

// ====================================================================
//  ⚠️ À COMPLÉTER : va sur https://console.firebase.google.com
//  → projet "kozons-69589" → icône ⚙️ Paramètres du projet
//  → onglet "Général" → section "Vos applications"
//  → si aucune appli Web n'existe : clique "Ajouter une application" > Web (</>)
//  → copie l'objet firebaseConfig affiché et colle-le ci-dessous.
// ====================================================================
const firebaseConfig = {
  apiKey: "AIzaSyC5XMlPNSv5zUi3uPznwG3p8ZZKU2pG92M", // déjà connue (google-services.json)
  authDomain: "kozons-69589.firebaseapp.com",
  projectId: "kozons-69589",
  storageBucket: "kozons-69589.firebasestorage.app",
  messagingSenderId: "551500429722",
  appId: "1:551500429722:web:aa70ee9f3717c335366223"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const firebaseAuth = getAuth(firebaseApp);

// Mode hors-ligne : Firestore garde les dernières données lues en cache local
// (IndexedDB du navigateur), donc le fil, les profils, etc. restent
// consultables même sans connexion. "persistentMultipleTabManager" évite les
// conflits si le site est ouvert dans plusieurs onglets en même temps.
export const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
