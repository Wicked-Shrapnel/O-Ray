O-Ray is an X-ray inspired Obsidian plugin that can be used to help the user write test plans. 

I was inspired to make this so that I could have somewhere to write plans offline where I could easily copy the steps and so I wouldn't have to rely on formatting a Word document. The plugin is designed for the user to easily be able to copy the steps to something like X-Ray as soon as they're ready. 

 The core features that X-Ray are here: 
- Write steps using action, data, and expected result. 
- Add additional steps above or below. Existing steps. 
- Click and drag to rearrange steps. 

![[Pasted image 20260825214803.png]]
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
