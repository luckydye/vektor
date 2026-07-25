// @types/prismjs only declares the package entry point, not the individual
// grammar components. They are side-effect imports that register themselves on
// the Prism singleton and export nothing useful, so an untyped module is the
// accurate shape (see editor/prism.ts).
declare module "prismjs/components/*";
