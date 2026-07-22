import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { firebaseAuth } from './firebase-config.js';

const SUPABASE_URL = "https://iryxexlyjgfcvwrrloox.supabase.co";
const SUPABASE_KEY = "sb_publishable_YvCyFGceRpdqnA-jqjOaCw_bHUrTc0d";

// Unification des comptes : chaque requête envoyée à Supabase porte le
// jeton Firebase de l'utilisateur connecté (Third-Party Auth), exactement
// comme sur l'app Android. Un compte créé sur le site fonctionne aussi
// dans l'app, et inversement.
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  accessToken: async () => {
    const utilisateur = firebaseAuth.currentUser;
    if (!utilisateur) return null;
    return (await utilisateur.getIdToken(false)) ?? null;
  }
});
