import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import {
  NativeModules,
  NativeEventEmitter,
  Platform,
  PermissionsAndroid,
  Alert,
} from 'react-native';
import { uploadAndSharePhoto } from '../services/photoService';

const { PhotoDetectionModule } = NativeModules;

interface QueueItem {
  path: string;
  timestamp: number;
}

interface PhotoSharingContextType {
  isSharing: boolean;
  activeGroupId: string | null;
  startSharing: (groupId: string, uploaderName: string) => void;
  stopSharing: () => void;
}

const PhotoSharingContext = createContext<PhotoSharingContextType>({
  isSharing: false,
  activeGroupId: null,
  startSharing: () => {},
  stopSharing: () => {},
});

export const usePhotoSharingContext = () => useContext(PhotoSharingContext);

export const PhotoSharingProvider = ({ children }: { children: ReactNode }): React.ReactNode => {
  const [isSharing, setIsSharing] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [uploaderName, setUploaderName] = useState<string | null>(null);

  const subscriptionRef = useRef<any>(null);
  const uploadQueueRef = useRef<QueueItem[]>([]);
  const isUploadingRef = useRef<boolean>(false);
  const groupIdRef = useRef<string | null>(null);
  const uploaderNameRef = useRef<string | null>(null);

  useEffect(() => {
    groupIdRef.current = activeGroupId;
    uploaderNameRef.current = uploaderName;
  }, [activeGroupId, uploaderName]);

  const requestPermissions = async (): Promise<boolean> => {
    try {
      if (Platform.OS !== 'android') return false;

      if (Platform.Version >= 33) {
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES,
          {
            title: 'Photo Access Permission',
            message: 'Orca needs access to your photos.',
            buttonPositive: 'Allow',
            buttonNegative: 'Deny',
          }
        );
        return result === PermissionsAndroid.RESULTS.GRANTED;
      } else {
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
          {
            title: 'Storage Permission',
            message: 'Orca needs storage access.',
            buttonPositive: 'Allow',
            buttonNegative: 'Deny',
          }
        );
        return result === PermissionsAndroid.RESULTS.GRANTED;
      }
    } catch (error) {
      console.log('Permission error:', error);
      return false;
    }
  };

  const processQueue = async (): Promise<void> => {
    if (isUploadingRef.current) return;
    if (uploadQueueRef.current.length === 0) return;

    isUploadingRef.current = true;
    console.log('Processing queue...');

    while (uploadQueueRef.current.length > 0) {
      const item = uploadQueueRef.current.shift();
      if (!item) continue;

      const { path, timestamp } = item;
      const age = Date.now() - timestamp;

      // Skip photos older than 60 seconds
      if (age > 60000) {
        continue;
      }

      if (!groupIdRef.current || !uploaderNameRef.current) {
        continue;
      }

      try {
        await uploadAndSharePhoto(
          path,
          groupIdRef.current,
          uploaderNameRef.current
        );
        console.log('✅ Upload success');
      } catch (error: any) {
        console.log('❌ Upload failed:', error.message);
        try {
          await new Promise<void>(resolve => setTimeout(resolve, 3000));
          await uploadAndSharePhoto(
            path,
            groupIdRef.current!,
            uploaderNameRef.current!
          );
          console.log('✅ Retry success');
        } catch (retryError: any) {
          console.log('❌ Retry failed:', retryError.message);
        }
      }

      await new Promise<void>(resolve => setTimeout(resolve, 1000));
    }

    isUploadingRef.current = false;
    console.log('Queue complete');
  };

  const startSharing = async (groupId: string, name: string) => {
    if (!PhotoDetectionModule) {
      Alert.alert('Error', 'Native module not found. Please rebuild app.');
      return;
    }

    const hasPermission = await requestPermissions();
    if (!hasPermission) {
      Alert.alert(
        'Permission Required',
        'Please allow photo access to enable auto sharing.'
      );
      return;
    }

    setActiveGroupId(groupId);
    setUploaderName(name);
    setIsSharing(true);
  };

  const stopSharing = () => {
    setIsSharing(false);
    setActiveGroupId(null);
    setUploaderName(null);
  };

  useEffect(() => {
    if (!isSharing || !activeGroupId) {
      console.log('Stopping sharing...');
      subscriptionRef.current?.remove();
      if (PhotoDetectionModule) {
        PhotoDetectionModule.stopService();
      }
      uploadQueueRef.current = [];
      isUploadingRef.current = false;
      return;
    }

    console.log('Starting service...');
    PhotoDetectionModule.startService();
    console.log('Service started!');

    const emitter = new NativeEventEmitter(PhotoDetectionModule);
    subscriptionRef.current = emitter.addListener(
      'NewPhotoDetected',
      (photoPath: string) => {
        console.log('📸 New photo detected:', photoPath);
        uploadQueueRef.current.push({
          path: photoPath,
          timestamp: Date.now(),
        });
        processQueue();
      }
    );

    console.log('✅ Photo sharing active!');

    return () => {
      console.log('Cleaning up sharing listener...');
      subscriptionRef.current?.remove();
      if (PhotoDetectionModule) {
        PhotoDetectionModule.stopService();
      }
    };
  }, [isSharing, activeGroupId]);

  return (
    <PhotoSharingContext.Provider value={{ isSharing, activeGroupId, startSharing, stopSharing }}>
      {children}
    </PhotoSharingContext.Provider>
  );
};