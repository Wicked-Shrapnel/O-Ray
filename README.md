**Overview**

O-Ray is an X-ray inspired Obsidian plugin that can be used to help the user write test plans. 

I was inspired to make this so that I could have somewhere to write plans offline where it was easy to use and didn't require any formatting in a Word document. The plugin is designed for the user to easily be able to copy the steps into something like X-Ray as soon as they're ready. 

 The core features of X-Ray are here: 
- Write steps using action, data, and expected result. 
- Add additional steps above or below existing steps. 
- Click and drag to rearrange steps. 

<img width="1280" height="907" alt="image" src="https://github.com/user-attachments/assets/48fc974d-8b1a-4c38-ba99-1fc3d2fc6667" />

The only thing that's missing is an inline way to format the text using bold, underline, color highlighting, etc. Which I do plan to add in the future. 

One new set of features that I added was step history, so the user can delete steps and save them to be restored later. Either replacing a step or restoring it side by side with its replacement. 
There are some minor bugs that I have discovered just as I'm publishing this, but the plugin is pretty solid. 

**General Workflow**
1. Drop the plugin files into your vault plugin folder. 
2. Activate the plugin. 
3. Navigate to the plugin settings and create a project. 
4. Click the new test plan button in the toolbar to the left. 
5. Select your project. 
**Note:** you can create new projects when creating a new test plan, but then the projects will be out of sync. I'll need to tighten that up in the next release. 
