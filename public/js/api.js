import { supabase } from './supabase-client.js';
import { firebaseAuth, db } from './firebase-config.js';
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, updateProfile, GoogleAuthProvider, signInWithPopup
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  collection, collectionGroup, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot, runTransaction, writeBatch,
  increment, serverTimestamp, documentId
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

const BUCKET = 'medias';

/* ================= AUTH (Firebase) ================= */
export const auth = {
  async inscription(email, motDePasse, nomComplet) {
    const cred = await createUserWithEmailAndPassword(firebaseAuth, email, motDePasse);
    if (nomComplet) await updateProfile(cred.user, { displayName: nomComplet });
    // Création du profil Firestore, comme le fait l'app Android à la première sauvegarde.
    await setDoc(doc(db, 'profiles', cred.user.uid), {
      nomComplet, nomComplet_lower: nomComplet.toLowerCase(),
      avatarUrl: null, couvertureUrl: null, bio: '', ville: '',
      nbAmis: 0, nbAbonnes: 0, nbAbonnements: 0
    }, { merge: true });
    return cred;
  },
  async connexion(email, motDePasse) {
    return await signInWithEmailAndPassword(firebaseAuth, email, motDePasse);
  },
  async connexionGoogle() {
    const cred = await signInWithPopup(firebaseAuth, new GoogleAuthProvider());
    const u = cred.user;
    const ref = doc(db, 'profiles', u.uid);
    const snap = await getDoc(ref);
    const donnees = {};
    if (u.displayName) { donnees.nomComplet = u.displayName; donnees.nomComplet_lower = u.displayName.toLowerCase(); }
    if (u.photoURL) donnees.avatarUrl = u.photoURL;
    if (!snap.exists() || snap.data().nbAbonnes === undefined) donnees.nbAbonnes = snap.data()?.nbAbonnes ?? 0;
    if (!snap.exists() || snap.data().nbAbonnements === undefined) donnees.nbAbonnements = snap.data()?.nbAbonnements ?? 0;
    if (!snap.exists() || snap.data().nbAmis === undefined) donnees.nbAmis = snap.data()?.nbAmis ?? 0;
    if (!snap.exists()) { donnees.bio = ''; donnees.ville = ''; }
    await setDoc(ref, donnees, { merge: true });
    return cred;
  },
  async deconnexion() { await signOut(firebaseAuth); },
  async session() {
    return new Promise((resolve) => {
      const unsub = onAuthStateChanged(firebaseAuth, (user) => { unsub(); resolve(user); });
    });
  },
  monId() { return firebaseAuth.currentUser?.uid ?? null; },
  onChange(cb) { onAuthStateChanged(firebaseAuth, (user) => cb(user)); }
};

const idsOf = (snap) => snap.docs.map(d => d.id);
const dataAvecId = (d) => ({ ...d.data(), id: d.id });

/* ================= PROFILS ================= */
function appliquerStatutEnLigne(p) {
  const dernier = Number(p.dernierePresence) || 0;
  const estRecent = (Date.now() - dernier) < 5 * 60 * 1000;
  return { ...p, enLigne: !!p.enLigne && estRecent };
}

export const profils = {
  async obtenir(id) {
    const snap = await getDoc(doc(db, 'profiles', id));
    if (!snap.exists()) return { id, nomComplet: '', nbAbonnes: 0, nbAbonnements: 0, nbAmis: 0 };
    return appliquerStatutEnLigne(dataAvecId(snap));
  },
  async marquerPresence(id) {
    await setDoc(doc(db, 'profiles', id), { enLigne: true, dernierePresence: String(Date.now()) }, { merge: true });
  },
  async modifier(id, champs) {
    const donnees = { ...champs };
    if (donnees.nomComplet) donnees.nomComplet_lower = donnees.nomComplet.toLowerCase();
    await setDoc(doc(db, 'profiles', id), donnees, { merge: true });
  },
  async rechercher(terme) {
    const t = terme.toLowerCase();
    const q = query(collection(db, 'profiles'),
      where('nomComplet_lower', '>=', t), where('nomComplet_lower', '<=', t + '\uf8ff'), limit(20));
    const snap = await getDocs(q);
    return snap.docs.map(dataAvecId);
  },
  async suggestions(excludeId, limite = 8) {
    const dejaSuivis = new Set(await mesAbonnementsIds(excludeId));
    const snap = await getDocs(query(collection(db, 'profiles'), limit(limite + dejaSuivis.size + 15)));
    return snap.docs.map(dataAvecId)
      .filter(p => p.id !== excludeId && !dejaSuivis.has(p.id))
      .slice(0, limite);
  },
  async rechercherPseudo(prefixe) {
    if (!prefixe) return [];
    const snap = await getDocs(query(collection(db, 'profiles'),
      where('pseudo', '>=', prefixe), where('pseudo', '<=', prefixe + '\uf8ff'), limit(6)));
    return snap.docs.map(dataAvecId).filter(p => p.pseudo);
  },
  async estAbonne(moiId, autreId) {
    const snap = await getDoc(doc(db, 'users', moiId, 'abonnements', autreId));
    return snap.exists();
  },
  async enregistrer(postId, userId) {
    await setDoc(doc(db, 'users', userId, 'enregistres', postId), { postId, at: String(Date.now()) });
  },
  async suivre(moiId, autreId) {
    const batch = writeBatch(db);
    batch.set(doc(db, 'users', moiId, 'abonnements', autreId), { at: Date.now() });
    batch.set(doc(db, 'users', autreId, 'abonnes', moiId), { at: Date.now() });
    batch.set(doc(db, 'profiles', moiId), { nbAbonnements: increment(1) }, { merge: true });
    batch.set(doc(db, 'profiles', autreId), { nbAbonnes: increment(1) }, { merge: true });
    await batch.commit();
    invaliderCacheListe(`abonnements:${moiId}`);
    await notifications.envoyer(autreId, 'ABONNE', moiId, 'a commencé à vous suivre');
  },
  async neplussuivre(moiId, autreId) {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'users', moiId, 'abonnements', autreId));
    batch.delete(doc(db, 'users', autreId, 'abonnes', moiId));
    batch.set(doc(db, 'profiles', moiId), { nbAbonnements: increment(-1) }, { merge: true });
    batch.set(doc(db, 'profiles', autreId), { nbAbonnes: increment(-1) }, { merge: true });
    await batch.commit();
    invaliderCacheListe(`abonnements:${moiId}`);
  },
  async listerAbonnements(uid) {
    const snap = await getDocs(collection(db, 'users', uid, 'abonnements'));
    return profilsParIds(snap.docs.map(d => d.id));
  },
  async listerAbonnes(uid) {
    const snap = await getDocs(collection(db, 'users', uid, 'abonnes'));
    return profilsParIds(snap.docs.map(d => d.id));
  }
};

async function profilsParIds(ids) {
  if (!ids.length) return [];
  const resultats = [];
  for (const bloc of chunk(ids, 30)) {
    const snap = await getDocs(query(collection(db, 'profiles'), where(documentId(), 'in', bloc)));
    resultats.push(...snap.docs.map(dataAvecId));
  }
  return resultats;
}

/* ================= FIL / POSTS ================= */
// Petit cache mémoire (60s) : ces listes changent rarement (suivre/quitter un
// canal), pas la peine de les redemander à chaque fois qu'on revient sur
// l'onglet Accueil — c'était une source majeure de lenteur au changement d'onglet.
const _cacheListes = new Map();
async function listeAvecCache(cle, chargeur, dureeMs = 60000) {
  const entree = _cacheListes.get(cle);
  if (entree && entree.expire > Date.now()) return entree.ids;
  const ids = await chargeur();
  _cacheListes.set(cle, { ids, expire: Date.now() + dureeMs });
  return ids;
}
export function invaliderCacheListe(cle) { _cacheListes.delete(cle); }

async function mesAbonnementsIds(uid) {
  return listeAvecCache(`abonnements:${uid}`, async () => {
    const snap = await getDocs(collection(db, 'users', uid, 'abonnements'));
    return idsOf(snap);
  });
}
async function mesCanauxSuivisIds(uid) {
  // Pas de collectionGroup ici (nécessite un index dédié côté Firestore) :
  // on relit simplement les canaux dont l'utilisateur est membre, un par un,
  // via la liste de ses canaux "suivis" mémorisée côté profil suffit pour un premier jet.
  // Solution simple et fiable : on interroge chaque canal public et on vérifie l'appartenance
  // serait coûteux ; on se base donc sur une sous-collection dédiée côté profil.
  return listeAvecCache(`canaux:${uid}`, async () => {
    const snap = await getDocs(collection(db, 'users', uid, 'mes_canaux'));
    return idsOf(snap);
  });
}

export const posts = {
  async fil(filtre = 'TOUS', limite = 20) {
    const uid = auth.monId();
    if (!uid) return [];

    // Mes abonnements + moi-même
    const followingIds = [...new Set([...(await mesAbonnementsIds(uid)), uid])].slice(0, 30);
    // Mes canaux (groupes/pages) — sauf si filtre = ABONNEMENTS
    const joinedChannels = filtre !== 'ABONNEMENTS' ? (await mesCanauxSuivisIds(uid)).slice(0, 30) : [];

    const requetes = [];
    if (filtre !== 'CANAUX' && followingIds.length) {
      requetes.push(getDocs(query(collection(db, 'posts'),
        where('auteurId', 'in', followingIds), orderBy('dateCreation', 'desc'), limit(limite))));
    }
    if (filtre !== 'ABONNEMENTS' && joinedChannels.length) {
      requetes.push(getDocs(query(collection(db, 'posts'),
        where('channelId', 'in', joinedChannels), orderBy('dateCreation', 'desc'), limit(limite))));
    }
    let tous = (await Promise.all(requetes)).flatMap(s => s.docs.map(dataAvecId));

    // Pas de fallback public : si l'utilisateur n'a pas encore d'abonnements,
    // le fil est vide → on affichera uniquement des suggestions de profils à suivre.

    const vus = new Set();
    tous = tous.filter(p => {
      if (vus.has(p.id)) return false;
      vus.add(p.id);
      return p.statutModeration === 'APPROUVE' || !p.statutModeration;
    }).sort((a, b) => Number(b.dateCreation) - Number(a.dateCreation)).slice(0, limite);

    // Enrichir avec ma réaction
    return Promise.all(tous.map(async (p) => {
      const r = await getDoc(doc(db, 'posts', p.id, 'reactions', uid));
      return { ...p, maReaction: r.exists() ? r.data().type : null };
    }));
  },
  async obtenir(id) {
    const snap = await getDoc(doc(db, 'posts', id));
    if (!snap.exists()) return null;
    return dataAvecId(snap);
  },
  async parCanal(channelId) {
    const snap = await getDocs(query(collection(db, 'posts'),
      where('channelId', '==', channelId), where('statutModeration', '==', 'APPROUVE'),
      orderBy('dateCreation', 'desc')));
    return snap.docs.map(dataAvecId);
  },
  async parAuteur(userId) {
    const snap = await getDocs(query(collection(db, 'posts'), where('auteurId', '==', userId), limit(60)));
    return snap.docs.map(dataAvecId)
      .filter(p => !p.channelId)
      .sort((a, b) => Number(b.dateCreation) - Number(a.dateCreation));
  },
  async medias(userId) {
    const tous = await this.parAuteur(userId);
    return tous.filter(p => p.typeMedia === 'IMAGE' || p.typeMedia === 'VIDEO');
  },
  async videos(limite = 30) {
    const snap = await getDocs(query(collection(db, 'posts'),
      where('typeMedia', '==', 'VIDEO'), orderBy('dateCreation', 'desc'), limit(limite)));
    return snap.docs.map(dataAvecId);
  },
  async publier({ auteurId, auteurNom, auteurAvatar, texte, typeMedia, mediaUrl, channelId, channelNom, couleurFond, medias, dureeAudioMs }) {
    await addDoc(collection(db, 'posts'), {
      auteurId, auteurNom, auteurAvatar: auteurAvatar || null,
      texte, typeMedia, mediaUrl: mediaUrl || null, couleurFond: couleurFond || null,
      medias: medias || [], dureeAudioMs: dureeAudioMs || null,
      dateCreation: String(Date.now()),
      channelId: channelId || null, channelNom: channelNom || null,
      nbLikes: 0, nbCommentaires: 0, nbVues: 0, nbPartages: 0,
      reactionsParType: {}, statutModeration: 'APPROUVE'
    });
  },
  async reagir(postId, type) {
    const uid = auth.monId();
    const postRef = doc(db, 'posts', postId);
    const reactionRef = doc(db, 'posts', postId, 'reactions', uid);
    await runTransaction(db, async (tx) => {
      const postSnap = await tx.get(postRef);
      const oldSnap = await tx.get(reactionRef);
      const oldType = oldSnap.exists() ? oldSnap.data().type : null;
      const reactions = { ...(postSnap.data()?.reactionsParType || {}) };
      let nbLikes = postSnap.data()?.nbLikes || 0;
      if (oldType) reactions[oldType] = (reactions[oldType] || 1) - 1; else nbLikes += 1;
      reactions[type] = (reactions[type] || 0) + 1;
      tx.set(reactionRef, { type, at: serverTimestamp() });
      tx.update(postRef, { reactionsParType: reactions, nbLikes });
    });
    const postSnap = await getDoc(postRef);
    const destId = postSnap.data()?.auteurId;
    if (destId) await notifications.envoyer(destId, 'REACTION', postId, `a réagi à votre publication`);
  },
  async maReaction(postId, userId) {
    const snap = await getDoc(doc(db, 'posts', postId, 'reactions', userId));
    return snap.exists() ? snap.data().type : null;
  },
  async listerReactions(postId) {
    const snap = await getDocs(collection(db, 'posts', postId, 'reactions'));
    const items = snap.docs.map(d => ({ uid: d.id, type: d.data().type }));
    if (!items.length) return [];
    const profils_ = await profilsParIds(items.map(i => i.uid));
    return items.map(i => ({ ...i, profil: profils_.find(p => p.id === i.uid) })).filter(i => i.profil);
  },
  async rechercherTexte(terme) {
    const snap = await getDocs(query(collection(db, 'posts'),
      where('texte', '>=', terme), where('texte', '<=', terme + '\uf8ff'), limit(20)));
    return snap.docs.map(dataAvecId);
  },
  async modifier(id, texte) {
    await updateDoc(doc(db, 'posts', id), { texte });
  },
  async supprimer(id) {
    await deleteDoc(doc(db, 'posts', id));
  },
  async signaler(postId, signalantId) {
    await addDoc(collection(db, 'signalements'), {
      postId, signalantId, at: String(Date.now())
    });
  },
  async reparerMonNom(userId, nomComplet, avatarUrl) {
    const mesPosts = await this.parAuteur(userId);
    const aReparer = mesPosts.filter(p => !p.auteurNom);
    if (!aReparer.length) return 0;
    const batch = writeBatch(db);
    aReparer.forEach(p => batch.update(doc(db, 'posts', p.id), { auteurNom: nomComplet, auteurAvatar: avatarUrl || null }));
    await batch.commit();
    return aReparer.length;
  }
};

/* ================= COMMENTAIRES ================= */
export const commentaires = {
  async lister(postId) {
    const snap = await getDocs(query(collection(db, 'posts', postId, 'commentaires'), orderBy('dateCreation', 'asc')));
    return snap.docs.map(dataAvecId).filter(c => !c.parentCommentaireId);
  },
  async ajouter({ postId, auteurId, auteurNom, auteurAvatar, texte, typeMedia, mediaUrl, dureeAudioMs }) {
    await addDoc(collection(db, 'posts', postId, 'commentaires'), {
      postId, parentCommentaireId: null, auteurId, auteurNom, auteurAvatar: auteurAvatar || null,
      texte: texte || '', typeMedia: typeMedia || 'TEXTE', mediaUrl: mediaUrl || null, dureeAudioMs: dureeAudioMs || null,
      dateCreation: String(Date.now()), nbReponses: 0, nbLikes: 0
    });
    await updateDoc(doc(db, 'posts', postId), { nbCommentaires: increment(1) });
    const postSnap = await getDoc(doc(db, 'posts', postId));
    const destId = postSnap.data()?.auteurId;
    if (destId) await notifications.envoyer(destId, 'COMMENTAIRE', postId, 'a commenté votre publication');
  },
  async modifier(postId, id, texte) {
    await updateDoc(doc(db, 'posts', postId, 'commentaires', id), { texte });
  },
  async supprimer(postId, id) {
    await deleteDoc(doc(db, 'posts', postId, 'commentaires', id));
    await updateDoc(doc(db, 'posts', postId), { nbCommentaires: increment(-1) });
  },
  async listerReponses(postId, parentId) {
    const snap = await getDocs(query(collection(db, 'posts', postId, 'commentaires'),
      where('parentCommentaireId', '==', parentId), orderBy('dateCreation', 'asc')));
    return snap.docs.map(dataAvecId);
  },
  async reparerMonNom(userId, nomComplet, avatarUrl) {
    const snap = await getDocs(query(collectionGroup(db, 'commentaires'), where('auteurId', '==', userId)));
    const aReparer = snap.docs.filter(d => !d.data().auteurNom);
    if (!aReparer.length) return 0;
    const batch = writeBatch(db);
    aReparer.forEach(d => batch.update(d.ref, { auteurNom: nomComplet, auteurAvatar: avatarUrl || null }));
    await batch.commit();
    return aReparer.length;
  },
  async repondre({ postId, parentId, auteurId, auteurNom, auteurAvatar, texte }) {
    await addDoc(collection(db, 'posts', postId, 'commentaires'), {
      postId, parentCommentaireId: parentId, auteurId, auteurNom, auteurAvatar: auteurAvatar || null,
      texte: texte || '', typeMedia: 'TEXTE', mediaUrl: null, dureeAudioMs: null,
      dateCreation: String(Date.now()), nbReponses: 0, nbLikes: 0
    });
    await updateDoc(doc(db, 'posts', postId, 'commentaires', parentId), { nbReponses: increment(1) });
    await updateDoc(doc(db, 'posts', postId), { nbCommentaires: increment(1) });
    const parentSnap = await getDoc(doc(db, 'posts', postId, 'commentaires', parentId));
    const destId = parentSnap.data()?.auteurId;
    if (destId) await notifications.envoyer(destId, 'REPONSE', postId, 'a répondu à votre commentaire');
  }
};

/* ================= CANAUX (Groupes / Pages) ================= */
export const canaux = {
  async mesCanaux(userId, type) {
    const ids = await mesCanauxSuivisIds(userId);
    if (!ids.length) return [];
    const resultats = [];
    for (const bloc of chunk(ids, 30)) {
      const snap = await getDocs(query(collection(db, 'channels'),
        where(documentId(), 'in', bloc), where('type', '==', type)));
      resultats.push(...snap.docs.map(dataAvecId));
    }
    return resultats;
  },
  async suggeres(type) {
    const uid = auth.monId();
    const mesIds = new Set(await mesCanauxSuivisIds(uid));
    const snap = await getDocs(query(collection(db, 'channels'),
      where('type', '==', type), orderBy('nbMembres', 'desc'), limit(20)));
    return snap.docs.map(dataAvecId).filter(c => !mesIds.has(c.id));
  },
  async obtenir(id) {
    const snap = await getDoc(doc(db, 'channels', id));
    return dataAvecId(snap);
  },
  async creer({ nom, type, description, proprietaireId }) {
    const ref = await addDoc(collection(db, 'channels'), {
      nom, nom_lower: nom.toLowerCase(), type, description,
      proprietaireId, nbMembres: 1
    });
    await setDoc(doc(db, 'channels', ref.id, 'membres', proprietaireId), { userId: proprietaireId, role: 'PROPRIETAIRE', at: Date.now() });
    await setDoc(doc(db, 'users', proprietaireId, 'mes_canaux', ref.id), { at: Date.now() });
    return { id: ref.id, nom, type, description, nbMembres: 1 };
  },
  async rejoindre(channelId, userId) {
    await setDoc(doc(db, 'channels', channelId, 'membres', userId), { userId, role: 'MEMBRE', at: Date.now() });
    await setDoc(doc(db, 'users', userId, 'mes_canaux', channelId), { at: Date.now() });
    await updateDoc(doc(db, 'channels', channelId), { nbMembres: increment(1) });
    invaliderCacheListe(`canaux:${userId}`);
  },
  async quitter(channelId, userId) {
    await deleteDoc(doc(db, 'channels', channelId, 'membres', userId));
    await deleteDoc(doc(db, 'users', userId, 'mes_canaux', channelId));
    await updateDoc(doc(db, 'channels', channelId), { nbMembres: increment(-1) });
    invaliderCacheListe(`canaux:${userId}`);
  },
  async estMembre(channelId, userId) {
    const snap = await getDoc(doc(db, 'channels', channelId, 'membres', userId));
    return snap.exists();
  },
  async modifier(channelId, champs) {
    await updateDoc(doc(db, 'channels', channelId), champs);
  },
  async supprimer(channelId) {
    await deleteDoc(doc(db, 'channels', channelId));
  },
  async listerMembres(channelId, limite = 20) {
    const snap = await getDocs(query(collection(db, 'channels', channelId, 'membres'), limit(limite)));
    const ids = snap.docs.map(d => d.id);
    if (!ids.length) return [];
    const profils_ = [];
    for (const bloc of chunk(ids, 30)) {
      const p = await getDocs(query(collection(db, 'profiles'), where(documentId(), 'in', bloc)));
      profils_.push(...p.docs.map(dataAvecId));
    }
    return profils_;
  },
  async rechercher(terme) {
    const t = terme.toLowerCase();
    const snap = await getDocs(query(collection(db, 'channels'),
      where('nom_lower', '>=', t), where('nom_lower', '<=', t + '\uf8ff'), limit(20)));
    return snap.docs.map(dataAvecId);
  }
};

function chunk(arr, taille) {
  const out = [];
  for (let i = 0; i < arr.length; i += taille) out.push(arr.slice(i, i + taille));
  return out;
}

/* ================= STORIES ================= */
export const stories = {
  async actives(typePublication = 'STORY') {
    const uid = auth.monId();
    const ilYa24h = String(Date.now() - 24 * 60 * 60 * 1000);
    const followingIds = [...new Set([...(await mesAbonnementsIds(uid)), uid])].slice(0, 30);
    const snap = await getDocs(query(collection(db, 'stories'),
      where('typePublication', '==', typePublication),
      where('auteurId', 'in', followingIds),
      where('dateCreation', '>', ilYa24h),
      orderBy('dateCreation', 'asc')));
    const items = await Promise.all(snap.docs.map(async (d) => {
      const s = dataAvecId(d);
      const vue = await getDoc(doc(db, 'stories', s.id, 'vues', uid));
      return { ...s, vue_par_moi: vue.exists(), auteur_avatar: s.auteurAvatar, auteur_nom: s.auteurNom, auteur_id: s.auteurId, media_url: s.mediaUrl, type_media: s.typeMedia };
    }));
    return items;
  },
  async reelsActifs() {
    return this.actives('REEL');
  },
  async marquerVue(storyId, userId) {
    const storyRef = doc(db, 'stories', storyId);
    const vueRef = doc(db, 'stories', storyId, 'vues', userId);
    await runTransaction(db, async (tx) => {
      const vueSnap = await tx.get(vueRef);
      if (!vueSnap.exists()) {
        tx.set(vueRef, { at: serverTimestamp() });
        tx.update(storyRef, { nbVues: increment(1) });
      }
    });
  },
  async aimer(storyId, userId) {
    const storyRef = doc(db, 'stories', storyId);
    const likeRef = doc(db, 'stories', storyId, 'reactions', userId);
    let dejaAime = false;
    await runTransaction(db, async (tx) => {
      const likeSnap = await tx.get(likeRef);
      dejaAime = likeSnap.exists();
      if (!dejaAime) {
        tx.set(likeRef, { type: 'JADORE', at: serverTimestamp() });
        tx.update(storyRef, { nbLikes: increment(1) });
      }
    });
    return !dejaAime;
  },
  async supprimerStory(storyId) {
    await deleteDoc(doc(db, 'stories', storyId));
  },
  async listerVues(storyId) {
    const snap = await getDocs(collection(db, 'stories', storyId, 'vues'));
    return profilsParIds(snap.docs.map(d => d.id));
  },
  async listerLikes(storyId) {
    const snap = await getDocs(collection(db, 'stories', storyId, 'reactions'));
    return profilsParIds(snap.docs.map(d => d.id));
  },
  async publier({ auteurId, auteurNom, auteurAvatar, typeMedia, mediaUrl, texte, couleurFond }) {
    // ⚠️ Le modèle Story côté Android a mediaUrl et couleurFond en non-nullable
    // (String, pas String?) — leur envoyer `null` fait planter la lecture
    // (toObject) et peut empêcher l'affichage de TOUTES les stories du lot,
    // pas seulement la nôtre. On envoie donc toujours une valeur, jamais null.
    await addDoc(collection(db, 'stories'), {
      auteurId, auteurNom, auteurAvatar: auteurAvatar || null,
      typeMedia: mediaUrl ? (typeMedia || 'IMAGE') : 'TEXTE',
      mediaUrl: mediaUrl || '',
      texte: texte || '',
      couleurFond: couleurFond || '#6A1B9A',
      typePublication: 'STORY',
      dateCreation: String(Date.now()), dateExpiration: String(Date.now() + 24 * 60 * 60 * 1000),
      nbLikes: 0, nbVues: 0
    });
  },
  async publierReel({ auteurId, auteurNom, auteurAvatar, typeMedia, mediaUrl, texte }) {
    // Les "Reels" partagent la même collection que les stories côté Android
    // (typePublication: "REEL" au lieu de "STORY"), avec la même durée de vie.
    await addDoc(collection(db, 'stories'), {
      auteurId, auteurNom, auteurAvatar: auteurAvatar || null,
      typeMedia: typeMedia || 'VIDEO', mediaUrl: mediaUrl || '', texte: texte || '',
      couleurFond: '#6A1B9A', typePublication: 'REEL',
      dateCreation: String(Date.now()), dateExpiration: String(Date.now() + 24 * 60 * 60 * 1000),
      nbLikes: 0, nbVues: 0
    });
  }
};

/* ================= NOTIFICATIONS ================= */
export const notifications = {
  async lister(userId) {
    const snap = await getDocs(query(collection(db, 'users', userId, 'notifications'), orderBy('date', 'desc'), limit(50)));
    return snap.docs.map(dataAvecId);
  },
  async envoyer(destinataireId, type, cibleId, texte) {
    const uid = auth.monId();
    if (!uid || uid === destinataireId) return;
    const moi = await profils.obtenir(uid);
    await addDoc(collection(db, 'users', destinataireId, 'notifications'), {
      destinataireId, type, acteurId: uid, acteurNom: moi.nomComplet || 'Utilisateur',
      acteurAvatar: moi.avatarUrl || null, cibleId, texte, lu: false, date: String(Date.now())
    });
    // Email EmailJS uniquement pour les abonnements (événement rare et important)
    // Les réactions/commentaires restent en notification in-app uniquement,
    // pour ne pas épuiser les 200 emails/mois du plan gratuit.
    try {
      if (type === 'ABONNE' && typeof emailjs !== 'undefined') {
        const dest = await profils.obtenir(destinataireId);
        if (dest?.email) {
          await emailjs.send('service_kozons', 'template_2pyg18d', {
            email_destinataire: dest.email,
            nom_destinataire: dest.nomComplet || 'Utilisateur',
            titre_notif: 'Nouvel abonné',
            message_notif: `${moi.nomComplet || 'Quelqu\'un'} s'est abonné(e) à toi sur KoZons.`
          });
        }
      }
    } catch { /* échec silencieux — la notif in-app est déjà envoyée */ }
  },
  async nonLues(userId) {
    const snap = await getDocs(query(collection(db, 'users', userId, 'notifications'), where('lu', '==', false)));
    return snap.size;
  },
  async toutMarquerLu(userId) {
    const snap = await getDocs(query(collection(db, 'users', userId, 'notifications'), where('lu', '==', false)));
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.update(d.ref, { lu: true }));
    await batch.commit();
  },
  ecouter(userId, cb) {
    return onSnapshot(query(collection(db, 'users', userId, 'notifications'), orderBy('date', 'desc'), limit(50)),
      (snap) => cb(snap.docs.map(dataAvecId)),
      () => {} // erreur réseau : on ignore, l'ancienne liste/badge reste affichée
    );
  }
};

/* ================= MESSAGES ================= */
export const messages = {
  async conversations() {
    const uid = auth.monId();
    if (!uid) return [];
    const snap = await getDocs(query(collection(db, 'conversations'),
      where('participants', 'array-contains', uid), orderBy('dateMaj', 'desc')));
    return Promise.all(snap.docs.map(async (d) => {
      const c = d.data();
      const autreId = (c.participants || []).find(p => p !== uid);
      const autre = autreId ? await profils.obtenir(autreId) : {};
      // Compter les messages non lus de cette conversation envoyés par l'autre
      const nonLusSnap = await getDocs(query(
        collection(db, 'conversations', d.id, 'messages'),
        where('expediteurId', '!=', uid),
        where('lu', '==', false)
      ));
      return {
        id: d.id, autre_id: autreId, autre_nom: autre.nomComplet || 'Utilisateur',
        autre_avatar: autre.avatarUrl, dernier_message: c.dernierMessage || '', date_maj: c.dateMaj,
        non_lus: nonLusSnap.size
      };
    }));
  },
  // Écoute en temps réel de toutes les conversations → badge messages mis à jour instantanément
  ecouterNonLus(uid, cb) {
    return onSnapshot(
      query(collection(db, 'conversations'), where('participants', 'array-contains', uid)),
      async (snap) => {
        let total = 0;
        await Promise.all(snap.docs.map(async (d) => {
          const nonLusSnap = await getDocs(query(
            collection(db, 'conversations', d.id, 'messages'),
            where('expediteurId', '!=', uid),
            where('lu', '==', false)
          ));
          total += nonLusSnap.size;
        }));
        cb(total);
      },
      () => {}
    );
  },
  async obtenir(conversationId) {
    const uid = auth.monId();
    const snap = await getDoc(doc(db, 'conversations', conversationId));
    if (!snap.exists()) return null;
    const c = snap.data();
    const autreId = (c.participants || []).find(p => p !== uid);
    const autre = autreId ? await profils.obtenir(autreId) : {};
    return { id: conversationId, autreId, autreNom: autre.nomComplet || 'Utilisateur', autreAvatar: autre.avatarUrl };
  },
  async ouvrirAvec(autreId) {
    const uid = auth.monId();
    const snap = await getDocs(query(collection(db, 'conversations'), where('participants', 'array-contains', uid)));
    const existante = snap.docs.find(d => (d.data().participants || []).includes(autreId));
    if (existante) return existante.id;
    const ref = await addDoc(collection(db, 'conversations'), {
      participants: [uid, autreId], dateMaj: String(Date.now()), dernierMessage: ''
    });
    return ref.id;
  },
  async historique(conversationId) {
    const snap = await getDocs(query(collection(db, 'conversations', conversationId, 'messages'), orderBy('dateEnvoi', 'asc')));
    return snap.docs.map(dataAvecId).map(m => ({ ...m, expediteur_id: m.expediteurId }));
  },
  async envoyer({ conversationId, expediteurId, texte, typeMedia, mediaUrl, dureeAudioMs, storyId, storyApercu, storyTypeMedia }) {
    await addDoc(collection(db, 'conversations', conversationId, 'messages'), {
      conversationId, expediteurId, texte: texte || '', typeMedia: typeMedia || 'TEXTE', mediaUrl: mediaUrl || null,
      dureeAudioMs: dureeAudioMs || null,
      storyId: storyId || null, storyApercu: storyApercu || null, storyTypeMedia: storyTypeMedia || null,
      lu: false, dateEnvoi: String(Date.now())
    });
    const dernierApercu = storyId ? `${texte || '👍'} · a réagi à une story` : (typeMedia === 'AUDIO' ? '🎤 Message vocal' : texte);
    await updateDoc(doc(db, 'conversations', conversationId), { dernierMessage: dernierApercu, dateMaj: String(Date.now()) });
    const convSnap = await getDoc(doc(db, 'conversations', conversationId));
    const destId = (convSnap.data()?.participants || []).find(p => p !== expediteurId);
    if (destId) await notifications.envoyer(destId, 'MESSAGE', conversationId, dernierApercu);
  },
  async modifierMessage(conversationId, messageId, texte) {
    await updateDoc(doc(db, 'conversations', conversationId, 'messages', messageId), {
      texte, modifie: true
    });
  },
  async supprimerMessage(conversationId, messageId) {
    await updateDoc(doc(db, 'conversations', conversationId, 'messages', messageId), {
      texte: '', supprime: true
    });
  },
  async marquerLue(conversationId) {
    const uid = auth.monId();
    const snap = await getDocs(query(
      collection(db, 'conversations', conversationId, 'messages'),
      where('expediteurId', '!=', uid),
      where('lu', '==', false)
    ));
    if (!snap.size) return;
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.update(d.ref, { lu: true }));
    await batch.commit();
  },
  ecouter(conversationId, cb) {
    return onSnapshot(query(collection(db, 'conversations', conversationId, 'messages'), orderBy('dateEnvoi', 'desc'), limit(1)),
      (snap) => {
        snap.docChanges().forEach(change => {
          if (change.type === 'added') cb({ new: { ...change.doc.data(), expediteur_id: change.doc.data().expediteurId } });
        });
      });
  }
};

/* ================= MARKETPLACE (Djassa) ================= */
export const djassa = {
  async lister() {
    const snap = await getDocs(query(collection(db, 'marketplace'), orderBy('dateCreation', 'desc'), limit(60)));
    return snap.docs.map(dataAvecId).map(a => ({ ...a, image_url: a.imageUrl, vendeur_nom: a.vendeurNom, date_creation: a.dateCreation, devise: a.devise || 'FCFA' }));
  },
  async publier({ vendeurId, titre, description, prix, categorie, imageUrl, imagesUrls, telephone }) {
    const moi = await profils.obtenir(vendeurId);
    await addDoc(collection(db, 'marketplace'), {
      vendeurId, vendeurNom: moi.nomComplet || 'Vendeur', titre, titre_lower: titre.toLowerCase(),
      description, prix: prix || 0, devise: 'FCFA', categorie: categorie || 'AUTRE',
      imageUrl: imageUrl || null, imagesUrls: imagesUrls?.length ? imagesUrls : (imageUrl ? [imageUrl] : []), telephone,
      dateCreation: String(Date.now())
    });
  },
  async obtenir(id) {
    const snap = await getDoc(doc(db, 'marketplace', id));
    if (!snap.exists()) return null;
    const a = dataAvecId(snap);
    return { ...a, image_url: a.imageUrl, vendeur_nom: a.vendeurNom, date_creation: a.dateCreation, devise: a.devise || 'FCFA', images_urls: a.imagesUrls || [] };
  },
  async rechercher(terme) {
    const t = terme.toLowerCase();
    const snap = await getDocs(query(collection(db, 'marketplace'),
      where('titre_lower', '>=', t), where('titre_lower', '<=', t + '\uf8ff'), limit(20)));
    return snap.docs.map(dataAvecId).map(a => ({ ...a, image_url: a.imageUrl, vendeur_nom: a.vendeurNom, devise: a.devise || 'FCFA' }));
  }
};

/* ================= STOCKAGE (Supabase — uniquement les fichiers) ================= */
export const stockage = {
  async televerser(fichier, dossier, onProgression) {
    const uid = auth.monId();
    let extension = fichier.name ? fichier.name.split('.').pop() : null;
    if (!extension) {
      const mime = fichier.type || '';
      if (mime.includes('webm')) extension = 'webm';
      else if (mime.includes('mp4')) extension = 'mp4';
      else if (mime.includes('ogg')) extension = 'ogg';
      else if (mime.includes('wav')) extension = 'wav';
      else extension = 'jpg';
    }
    const chemin = `${uid}/${dossier}/${Date.now()}.${extension}`;

    // Si un callback de progression est fourni, on utilise XHR pour avoir
    // des événements de progression réels. Sinon, on utilise le SDK Supabase.
    if (onProgression) {
      const { data: { session } } = await supabase.auth.getSession();
      const supabaseUrl = 'https://iryxexlyjgfcvwrrloox.supabase.co';
      const url = `${supabaseUrl}/storage/v1/object/${BUCKET}/${chemin}`;
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.setRequestHeader('Authorization', `Bearer ${session?.access_token}`);
        xhr.setRequestHeader('x-upsert', 'true');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgression(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => xhr.status < 300 ? resolve() : reject(new Error(`Erreur ${xhr.status}`));
        xhr.onerror = () => reject(new Error('Erreur réseau'));
        const form = new FormData();
        form.append('', fichier, `${Date.now()}.${extension}`);
        xhr.send(form);
      });
    } else {
      const { error } = await supabase.storage.from(BUCKET).upload(chemin, fichier, { upsert: true });
      if (error) throw error;
    }
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(chemin);
    return data.publicUrl;
  }
};
