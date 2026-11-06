import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import 'react-native-reanimated'
import { AppProviders } from '@/components/app-providers'
import { CompanionProvider } from '@/features/companion/companion-provider'

export default function RootLayout() {
  return (
    <AppProviders>
      <CompanionProvider>
        <Stack>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="pairing" options={{ title: 'Pair this phone' }} />
          <Stack.Screen name="roster" options={{ title: 'Your bots' }} />
          <Stack.Screen name="search" options={{ title: 'Search' }} />
          <Stack.Screen name="routines" options={{ title: 'Routines' }} />
          <Stack.Screen name="connectors" options={{ title: 'Connected apps' }} />
          <Stack.Screen name="thread/[id]" options={{ title: 'Conversation' }} />
        </Stack>
        <StatusBar style="auto" />
      </CompanionProvider>
    </AppProviders>
  )
}
