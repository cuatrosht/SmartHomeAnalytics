// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getDatabase } from "firebase/database";
import { getStorage } from "firebase/storage";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyD4ijfjR1yCJ535_kJQD8xiSLtvaOgVHHE",
  authDomain: "smarthomeanalytics-a9de2.firebaseapp.com",
  projectId: "smarthomeanalytics-a9de2",
  storageBucket: "smarthomeanalytics-a9de2.firebasestorage.app",
  messagingSenderId: "725719111805",
  appId: "1:725719111805:web:ff863e9ebc96757bfdb914",
  measurementId: "G-SKD92GKHTR"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

// Initialize Firebase services
const auth = getAuth(app);
const db = getFirestore(app);
const realtimeDb = getDatabase(app);
const storage = getStorage(app);

export { 
  app, 
  analytics, 
  auth, 
  db, 
  realtimeDb, 
  storage 
};
export default app;
