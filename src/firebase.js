// Replace the below config with your Firebase project config
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyDAUI4Uso1kmI7lNvvBMe8iNftGx4NWq2E",
  authDomain: "tejas1-1e1dc.firebaseapp.com",
  projectId: "tejas1-1e1dc",
  storageBucket: "tejas1-1e1dc.firebasestorage.app",
  messagingSenderId: "1051345025879",
  appId: "1:1051345025879:web:00f30bef42b7e454209c12",
  measurementId: "G-Y6247RHNR8"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
