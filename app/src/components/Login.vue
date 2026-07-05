<script setup lang="ts">
import { ref } from "vue";
import { authClient } from "#composeables/auth-client.ts";
import { config } from "#config";
import {
  ButtonPrimary,
  ButtonSecondary,
  FormField,
  Input,
} from "~/src/components/index.ts";

const conf = config();
const showPasswordLogin = conf.AUTH_LOGIN !== "false";
const showSsoLogin = !!conf.OAUTH_PROVIDER_ID;
const showGoogleLogin = conf.GOOGLE_AUTH_ENABLED === "1";

const email = ref("");
const password = ref("");
const name = ref("");
const isSignUp = ref(false);
const error = ref("");
const loading = ref(false);

async function onOAuthLogin() {
  if (!conf.OAUTH_PROVIDER_ID) {
    throw new Error("OAUTH_PROVIDER_ID is not configured");
  }

  await authClient.signIn.oauth2({
    providerId: conf.OAUTH_PROVIDER_ID,
    callbackURL: "/",
    errorCallbackURL: "/error",
    newUserCallbackURL: "/",
    disableRedirect: false,
    scopes: ["email", "profile", "openid"],
    requestSignUp: false,
  });
}

async function onGoogleLogin() {
  await authClient.signIn.social({
    provider: "google",
    callbackURL: "/",
    errorCallbackURL: "/error",
    newUserCallbackURL: "/",
  });
}

async function onEmailLogin() {
  if (!email.value || !password.value) {
    error.value = "Email and password are required, mate!";
    return;
  }

  if (isSignUp.value && !name.value) {
    error.value = "Name is required for sign up";
    return;
  }

  loading.value = true;
  error.value = "";

  try {
    if (isSignUp.value) {
      const response = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: email.value,
          password: password.value,
          name: name.value,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Sign up failed");
      }

      window.location.href = "/";
    } else {
      const result = await authClient.signIn.email({
        email: email.value,
        password: password.value,
        callbackURL: "/",
      });

      if (!result.error) {
        window.location.href = "/";
      } else {
        throw new Error(result.error.message || "Sign in failed");
      }
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Authentication failed, mate!";
  } finally {
    loading.value = false;
  }
}

function toggleMode() {
  isSignUp.value = !isSignUp.value;
  error.value = "";
}
</script>

<template>
  <div class="w-full space-y-5">
    <div v-if="showPasswordLogin || showSsoLogin || showGoogleLogin" class="mb-7">
      <h2 class="font-semibold text-neutral-900" style="font-size: 1.6rem; line-height: 1.2; letter-spacing: -0.02em">
        {{ isSignUp ? "Create an account" : "Welcome back" }}
      </h2>
      <p class="text-size-medium text-neutral-500 mt-1.5">
        {{ isSignUp ? "Set up your Vektor workspace" : "Sign in to your workspace" }}
      </p>
    </div>

    <form v-if="showPasswordLogin" @submit.prevent="onEmailLogin" class="space-y-4">
      <FormField v-if="isSignUp" label="Name">
        <Input
          v-model="name"
          placeholder="Your Name"
          type="text"
          :disabled="loading"
        />
      </FormField>

      <FormField label="Email">
        <Input
          v-model="email"
          placeholder="your.email@example.com"
          type="email"
          :disabled="loading"
        />
      </FormField>

      <FormField label="Password">
        <Input
          v-model="password"
          placeholder="••••••••"
          type="password"
          :disabled="loading"
        />
      </FormField>

      <div v-if="error" class="text-red-600 text-size-medium p-2 bg-red-50 rounded-sm">
        {{ error }}
      </div>

      <ButtonPrimary
        :text="loading ? 'Loading...' : (isSignUp ? 'Sign Up' : 'Sign In')"
        class="w-full px-6 py-3 text-base justify-center"
        type="submit"
        :disabled="loading"
      />

      <button
        type="button"
        @click="toggleMode"
        class="w-full text-size-medium text-neutral-500 hover:text-neutral-700 transition-colors"
        :disabled="loading"
      >
        {{ isSignUp ? "Already have an account? Sign in" : "Need an account? Sign up" }}
      </button>
    </form>

    <div v-if="showPasswordLogin && (showSsoLogin || showGoogleLogin)" class="relative">
      <div class="absolute inset-0 flex items-center">
        <div class="w-full border-t border-neutral"></div>
      </div>
      <div class="relative flex justify-center text-size-medium">
        <span class="px-2 bg-background text-neutral">Or</span>
      </div>
    </div>

    <ButtonSecondary
      v-if="showGoogleLogin"
      text="Continue with Google"
      class="w-full px-6 py-3 text-base justify-center"
      @click="onGoogleLogin"
      :disabled="loading"
    />

    <ButtonSecondary
      v-if="showSsoLogin"
      text="Continue with SSO"
      class="w-full px-6 py-3 text-base justify-center"
      @click="onOAuthLogin"
      :disabled="loading"
    />

    <div v-if="!showPasswordLogin && !showSsoLogin && !showGoogleLogin" class="text-size-medium text-center text-neutral">
      No login method configured.
    </div>
  </div>
</template>
