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
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyDWHgkfY4wdrOHE6W3YKkJR08vt3du83KI",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "smartanalytics-a0b63.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "smartanalytics-a0b63",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "smartanalytics-a0b63.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "259139645189",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:259139645189:web:e1c319177e6a5feb9f916c",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-D8QQ1EFDQ1"
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
