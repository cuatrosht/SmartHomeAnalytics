# Firebase Integration Guide

## Overview
This project has been configured with Firebase services including:
- **Authentication** - User sign-in/sign-up
- **Firestore** - NoSQL document database
- **Realtime Database** - Real-time data synchronization
- **Storage** - File storage
- **Analytics** - User behavior tracking

## Configuration
Firebase is configured in `src/firebase/config.ts` with your project credentials.

## Available Services

### 1. Authentication (`auth`)
```typescript
import { auth } from '../firebase/config';
import { signInAnonymously, signInWithEmailAndPassword } from 'firebase/auth';

// Anonymous sign-in
const signIn = async () => {
  const result = await signInAnonymously(auth);
  console.log('User:', result.user);
};
```

### 2. Firestore (`db`)
```typescript
import { db } from '../firebase/config';
import { collection, addDoc, getDocs, doc, updateDoc, deleteDoc } from 'firebase/firestore';

// Add document
const addData = async () => {
  const docRef = await addDoc(collection(db, 'users'), {
    name: 'John Doe',
    email: 'john@example.com'
  });
};

// Read documents
const readData = async () => {
  const querySnapshot = await getDocs(collection(db, 'users'));
  querySnapshot.forEach((doc) => {
    console.log(doc.id, ' => ', doc.data());
  });
};
```

### 3. Realtime Database (`realtimeDb`)
```typescript
import { realtimeDb } from '../firebase/config';
import { ref, set, get, push, onValue } from 'firebase/database';

// Write data
const writeData = async () => {
  await set(ref(realtimeDb, 'users/' + userId), {
    name: 'John Doe',
    email: 'john@example.com'
  });
};

// Read data
const readData = async () => {
  const snapshot = await get(ref(realtimeDb, 'users'));
  if (snapshot.exists()) {
    console.log(snapshot.val());
  }
};

// Listen for real-time updates
const listenToData = () => {
  const userRef = ref(realtimeDb, 'users/' + userId);
  onValue(userRef, (snapshot) => {
    const data = snapshot.val();
    console.log('Data updated:', data);
  });
};
```

### 4. Storage (`storage`)
```typescript
import { storage } from '../firebase/config';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';

// Upload file
const uploadFile = async (file: File) => {
  const storageRef = ref(storage, 'files/' + file.name);
  const snapshot = await uploadBytes(storageRef, file);
  const downloadURL = await getDownloadURL(snapshot.ref);
  return downloadURL;
};
```

### 5. Analytics (`analytics`)
```typescript
import { analytics } from '../firebase/config';
import { logEvent } from 'firebase/analytics';

// Log custom events
const logCustomEvent = () => {
  logEvent(analytics, 'button_click', {
    button_name: 'submit_form',
    page: 'contact'
  });
};
```

## Example Component
Check out `src/components/FirebaseExample.tsx` for a working example of all Firebase services.

## Security Rules
Make sure to configure proper security rules in your Firebase console for:
- Firestore
- Realtime Database
- Storage

## Environment Variables (Recommended)
For production, consider moving Firebase config to environment variables:

```typescript
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  // ... other config
};
```

Create a `.env.local` file:
```
VITE_FIREBASE_API_KEY=your_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_auth_domain
# ... other variables
```

## Next Steps
1. Test the FirebaseExample component
2. Configure security rules in Firebase console
3. Set up authentication methods you want to use
4. Create your data models and collections
5. Implement your specific Firebase features

## Troubleshooting
- Check browser console for errors
- Verify Firebase project configuration
- Ensure proper security rules are set
- Check if services are enabled in Firebase console
